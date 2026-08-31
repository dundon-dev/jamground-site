// Editorial vocabulary: all editor-facing strings, no git mechanics.
// Editors must never encounter the words branch, commit, merge, rebase, or pull request,
// and must never be asked to resolve a conflict in git terms.

export const VOCAB = {
  // Sign-in: not a git term, so nothing here needs to be translated away from one —
  // this is the whole constraint on the word chosen.
  signIn: 'sign in',

  // Core actions
  startAChange: 'start a change',
  save: 'save this change',
  preview: 'preview',
  sendForReview: 'send for review',
  publish: 'publish',

  // Conflict resolution
  conflictMessage: 'someone else changed this — review the differences',

  // Sign-in failure modes (both are real editor-facing failures)
  signInPopupBlocked: 'your browser blocked the sign-in window — allow pop-ups for this site and try again',
  signInNotVerified: 'sign-in could not be verified — please try again',
  signInFailed: 'sign-in did not complete — please try again',

  // Sign-in success: a non-empty message so signing in and nothing-happening
  // stop looking identical.
  signedIn: 'signed in',

  // Action feedback. None of these is a git term — the constraint is
  // test/gates/editorial-vocabulary.test.mjs, which scans this module's string literals.
  // Said when something in the content could not be opened for editing here. Deliberately says
  // what is TRUE of the person's work — it is untouched and safe — rather than describing the
  // editor's internals. Before this existed the same condition produced an empty editor and a
  // console message, which is indistinguishable from the tool being broken.
  // The other refusal, and a different fact: nothing could be opened at all, because the content
  // itself could not be read. Distinct from contentHeldBack so the two are never confused — one
  // means "this editor is unfinished", the other means "the content is broken".
  contentUnreadable: 'the content could not be opened. Nothing has been changed — please report this.',
  contentHeldBack: 'some content cannot be edited here yet. It is not shown, and nothing you save will change it:',
  changeStarted: 'a change is now open',
  // Said when the change opens, because that is the earliest moment the address is known — the
  // site itself takes about a minute to appear, and a link offered with no warning of that reads
  // as broken for the whole of its first minute.
  stagingPreparing: 'your staging site is being prepared — it will be ready at this address in about a minute:',
  startAChangeFailed: 'starting a change did not complete — please try again',
  changeAlreadyOpen: 'a change is already open — finish it first',
  notInChange: 'start a change before doing this',
  noContentChange: 'make and save a change first',
  // `saved: 'saved'` used to be here, and `sentForReview` below it. Both were replaced rather than
  // joined: each said its word and nothing else, and showStatus replaces the status line outright,
  // so each was a place the staging address was silently thrown away. Two entries saying the same
  // thing, one with the address and one without, is an invitation to call the wrong one.
  //
  // Said WITH the staging address attached, because the moment after a save is the moment an
  // editor most wants it and the moment it is least likely to still be on screen: showStatus
  // replaces the status line outright, so the address handed over when the change opened is gone
  // by now. Saving is also the action that actually causes the rebuild — GitHub sends
  // `synchronize` when the branch moves, and that is the delivery the box turns into a preview —
  // so promising an update here is a statement about what just happened, not a hope.
  savedStagingUpdating: 'saved — your staging site is updating and will show this in about a minute at:',
  nothingToSave: 'there is nothing new to save',
  saveFailed: 'save did not complete — please try again',
  // The same address again, and deliberately NOT a second promise of an update. Sending for
  // review moves no content, so nothing rebuilds — the box ignores that delivery on purpose. The
  // staging site is still showing the last save, and saying so is what stops an editor waiting
  // for a change that is already there.
  sentForReviewStagingAt: 'the change has been sent for review — it is still showing at:',
  sendForReviewFailed: 'sending for review did not complete — please try again',
  published: 'published',
  // Said with the live site's address attached. Publishing closes the change, and a closed change
  // has no staging site — the link offered when it opened is torn down within the minute. Ending
  // on the address that IS now correct closes the loop; leaving the old one on screen would hand
  // the editor a link that worked a moment ago and does not now, which reads as a fault.
  //
  // IT SAYS "IS BEING UPDATED", NOT "IS ON". The wording used to assert the change was already
  // live, and for the whole of that wording's life it was false: nothing rebuilt production, so
  // the live site kept serving the previous release and the editor had been told otherwise. A
  // merge now does trigger a deploy, but a deploy is a build — minutes, not the instant this
  // message appears — so the honest sentence is the one that names the delay. An editor who
  // follows the link immediately and sees the old text must be able to read that as "not yet"
  // rather than as "it did not work".
  publishedLiveAt: 'published — the live site is being updated and will show this in a few minutes at:',
  publishFailed: 'publishing did not complete — please try again',

  // Two refusals that belong to pages, and that reach the editor through the save path.
  //
  // Both are said INSTEAD of `saveFailed`, which would be true but useless: "save did not
  // complete — please try again" invites an editor to try the same thing again forever, and
  // neither of these ever succeeds on a retry. Each names the one thing that would fix it.
  //
  // The home page's address is how the site finds its front page (src/pages/[locale]/
  // index.astro selects it, [slug].astro excludes it), so renaming it does not move the
  // homepage, it removes it.
  homePageAddressFixed:
    'the home page has to keep the address "home" — that address is how the site finds its front page, and a different one would leave the site without one. Put it back and save again.',
  // A page must carry at least one piece of content (the contract's own rule), so an emptied
  // page cannot be written at all.
  pageNeedsContent:
    'a page cannot be saved with nothing on it — put some content back on the page first.',

  // A third refusal, belonging to authors, and reaching the editor the same way.
  //
  // An author is a person, not a document — the contract gives them a name, a role and a
  // short biography, and nowhere at all to keep a page of writing. Text put on the canvas
  // would have no home on disk, so a save that accepted it would have to throw it away
  // silently. The name of the person is appended, because an editor with several open cannot
  // act on "an author".
  authorHasNoBody:
    'an author is a person, not a page — there is nowhere to keep writing on this screen, so take it off and save again:',
};

/**
 * An error whose message is ALREADY the editor-facing sentence, marked so the shell says it
 * rather than replacing it with a generic one.
 *
 * The shell's save handler otherwise reports every failure as `saveFailed`, which is right for
 * a network error and wrong for a refusal that names its own remedy: the editor is told to try
 * again at the one moment trying again cannot work. `editorial` is the flag entry.mjs checks;
 * an ordinary Error carries no such property, so the generic message stays the default.
 */
export function editorialError(message) {
  const error = new Error(message);
  error.editorial = true;
  return error;
}
