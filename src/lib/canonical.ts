/* The canonical YAML writer.
 *
 *   ENVELOPE_ORDER   Not used for key order — a hand-written list is a second source of truth
 *                    that can silently drift from the schema. Key order instead derives from
 *                    `Object.keys(schema.shape)`, walked in parallel with the value, for every
 *                    object at every depth — so there is no second list to drift.
 *   orderKeys()      Applying one hand-written order at every nesting depth only produces
 *                    correct output if no nested object happens to share a key name with an
 *                    outer one — luck, not design. Walking value and schema in parallel
 *                    removes the possibility of collision entirely.
 *   prune()          Deleting empty strings reports a present-but-empty REQUIRED field to the
 *                    editor as MISSING. An empty string is a value here (`''`), legal wherever
 *                    the schema's own `parse()` accepts it.
 *   OPTS             No `nullStr: ''` — that would mask a stray null as an empty scalar. No
 *                    contract field is nullable, so a null reaching the writer is a
 *                    programming error and throws instead. The option set below is complete
 *                    and explicit, pinned so a `yaml` upgrade that changes a default fails a
 *                    test rather than silently rewriting the repository.
 *
 * Order of operations: parse -> prune -> order -> protect -> emit.
 * `write()` parses against the schema FIRST and throws on failure, so an invalid value can
 * never reach the emitter — which is what lets `prune` stop deleting empty strings (emptiness
 * is a schema question with an accurate error message) and lets `null` throw rather than
 * silently emit.
 */
import { YAMLMap, Scalar, stringify as yamlStringify, parse as yamlParse } from 'yaml';
import type { ZodType } from 'zod';

/** Scalars that a YAML 1.1 resolver (PyYAML, libyaml, Ruby Psych, many Go/Java libs) would
 *  read as something other than a string. YAML 1.2 core does not, so the `yaml` package will
 *  not quote them on its own — we must, on keys as well as values. */
const YAML11_HAZARD = new RegExp([
  '^(y|Y|yes|Yes|YES|n|N|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF)$',
  '^(~|null|Null|NULL|)$',
  '^[-+]?[0-9]+$',                                       // int
  '^[-+]?0[bo]?[0-7_]+$',                                // octal / binary
  '^[-+]?0x[0-9a-fA-F_]+$',                              // hex
  '^[-+]?([0-9][0-9_]*)?\\.[0-9_]*([eE][-+]?[0-9]+)?$',  // float
  '^[-+]?\\.(inf|Inf|INF|nan|NaN|NAN)$',
  '^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+$',                  // sexagesimal — "12:30" -> 750
  '^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+\\.[0-9_]*$',
  '^\\d{4}-\\d{1,2}-\\d{1,2}([Tt ].*)?$',                // date / timestamp
].join('|'));

export function needsQuote(s: string): boolean {
  return YAML11_HAZARD.test(s);
}

/** The exact, explicit option set — every option the writer depends on is passed
 *  even where it matches the library default, so a `yaml` upgrade that changes a default
 *  fails a fixture instead of silently rewriting the repository. `nullStr` is deliberately
 *  absent: a stray null must throw, never emit as an empty scalar. */
const OPTS = {
  indent: 2,
  indentSeq: true,
  lineWidth: 0,
  singleQuote: true,
  blockQuote: 'literal' as const,
  minContentWidth: 0,
  simpleKeys: true,
};

type ZodDef = {
  type: string;
  shape?: Record<string, ZodType>;
  innerType?: ZodType;
  element?: ZodType;
  options?: ZodType[];
  discriminator?: string;
  valueType?: ZodType;
  values?: unknown[];
};

function def(schema: ZodType): ZodDef {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (schema as any)._zod.def as ZodDef;
}

/** Unwrap `.optional()` (and any other transparent single-innerType wrapper) to reach the
 *  schema that actually describes the value's shape. */
function unwrap(schema: ZodType): ZodType {
  const d = def(schema);
  return d.innerType ? unwrap(d.innerType) : schema;
}

/** Pick the union member that matches `value`, preferring the discriminator field when the
 *  union declares one (e.g. blocks.ts's Block union), and falling back to `safeParse` against
 *  each option otherwise (defs.ts's MediaRef, an undiscriminated union of two object shapes). */
function pickUnionMember(value: unknown, d: ZodDef): ZodType {
  const options = d.options ?? [];
  if (d.discriminator && value && typeof value === 'object') {
    const tag = (value as Record<string, unknown>)[d.discriminator];
    for (const option of options) {
      const optDef = def(unwrap(option));
      const field = optDef.shape?.[d.discriminator];
      if (field && def(field).values?.includes(tag)) return option;
    }
  }
  for (const option of options) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((option as any).safeParse(value).success) return option;
  }
  throw new Error('canonical writer: no union member matches value — schema.parse() should have rejected this already');
}

/** `null` reaching the writer is a programming error: no contract field is nullable,
 *  so this throws rather than silently emitting an empty scalar. Absent optionals are
 *  omitted; an empty string is a value, kept as-is. Unicode is NFC-normalised. */
function prune(v: unknown): unknown {
  if (v === null) throw new Error('canonical writer: null is never written — no contract field is nullable');
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(prune);
  if (typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const p = prune(val);
      if (p !== undefined) o[k] = p;
    }
    return o;
  }
  return typeof v === 'string' ? v.normalize('NFC') : v;
}

/** Key order derives from the schema (`Object.keys(schema.shape)` order), walked in parallel
 *  with the value, for every object at every depth. Arrays are never sorted.
 *  For a union, the matched member's shape governs, so a discriminated union's `type` is
 *  always first. `z.record()` fields keep the value's own key order — there is no schema shape
 *  to derive one from. */
function orderKeys(value: unknown, schema: ZodType): unknown {
  const resolved = unwrap(schema);
  const d = def(resolved);

  if (d.type === 'union') {
    if (value === undefined) return value;
    const member = pickUnionMember(value, d);
    return orderKeys(value, member);
  }

  if (d.type === 'object') {
    if (value === undefined) return value;
    const shape = d.shape ?? {};
    const v = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      if (Object.prototype.hasOwnProperty.call(v, key)) out[key] = orderKeys(v[key], shape[key]);
    }
    return out;
  }

  if (d.type === 'array') {
    if (value === undefined) return value;
    const element = d.element as ZodType;
    return (value as unknown[]).map(item => orderKeys(item, element));
  }

  if (d.type === 'record') {
    if (value === undefined) return value;
    const valueType = d.valueType as ZodType;
    const v = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) out[key] = orderKeys(v[key], valueType);
    return out;
  }

  return value;
}

/** Wrap hazardous strings so the emitter is forced to quote them — applies to keys as well as
 *  values, since an unquoted key `off:` is read as boolean `false` by a YAML 1.1 parser. */
const q = (s: string): Scalar => {
  const n = new Scalar(s);
  n.type = Scalar.QUOTE_SINGLE;
  return n;
};

function protect(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(protect);
  if (v && typeof v === 'object') {
    const m = new YAMLMap();
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      m.add({ key: needsQuote(k) ? q(k) : k, value: protect(x) });
    }
    return m;
  }
  if (typeof v === 'string' && needsQuote(v)) return q(v);
  return v;
}

/** Every string scalar forced to double quotes — the one YAML scalar style with no
 *  unescapable content — used only by the total-emission safety net below. */
function protectDouble(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(protectDouble);
  if (v && typeof v === 'object') {
    const m = new YAMLMap();
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      const key = new Scalar(k); key.type = Scalar.QUOTE_DOUBLE;
      m.add({ key, value: protectDouble(x) });
    }
    return m;
  }
  if (typeof v === 'string') { const n = new Scalar(v); n.type = Scalar.QUOTE_DOUBLE; return n; }
  return v;
}

/** parse -> prune -> order -> protect -> emit. `schema.parse()` runs first and throws
 *  on failure, so an invalid value never reaches the emitter. After emitting, a total-emission
 *  safety net asserts `read(write(x)) === x` for the whole document; on failure every scalar is
 *  re-emitted double-quoted, which is total because double-quoting is the one YAML scalar
 *  style with no unescapable content — cheaper than reasoning about every hostile scalar in
 *  advance, and it cannot regress silently. */
export function write<T>(value: T, schema: ZodType): string {
  const parsed = schema.parse(value);
  const pruned = prune(parsed);
  const ordered = orderKeys(pruned, schema);
  const out = yamlStringify(protect(ordered), OPTS);
  if (deepEqual(yamlParse(out), pruned)) return out;
  return yamlStringify(protectDouble(ordered), OPTS);
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ak = Object.keys(a as Record<string, unknown>);
    const bk = Object.keys(b as Record<string, unknown>);
    if (ak.length !== bk.length) return false;
    return ak.every(k => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
  }
  return false;
}

export function read(s: string): unknown {
  return yamlParse(s);
}
