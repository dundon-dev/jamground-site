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
  changeStarted: 'a change is now open',
  // Said when the change opens, because that is the earliest moment the address is known — the
  // site itself takes about a minute to appear, and a link offered with no warning of that reads
  // as broken for the whole of its first minute.
  stagingPreparing: 'your staging site is being prepared — it will be ready at this address in about a minute:',
  startAChangeFailed: 'starting a change did not complete — please try again',
  changeAlreadyOpen: 'a change is already open — finish it first',
  notInChange: 'start a change before doing this',
  noContentChange: 'make and save a change first',
  saved: 'saved',
  nothingToSave: 'there is nothing new to save',
  saveFailed: 'save did not complete — please try again',
  sentForReview: 'the change has been sent for review',
  sendForReviewFailed: 'sending for review did not complete — please try again',
  published: 'published',
  // Said with the live site's address attached. Publishing closes the change, and a closed change
  // has no staging site — the link offered when it opened is torn down within the minute. Ending
  // on the address that IS now correct closes the loop; leaving the old one on screen would hand
  // the editor a link that worked a moment ago and does not now, which reads as a fault.
  publishedLiveAt: 'published — your change is on the live site at:',
  publishFailed: 'publishing did not complete — please try again',
};
