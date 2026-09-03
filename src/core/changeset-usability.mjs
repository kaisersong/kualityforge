// The one place that decides whether a frozen changeset counts as evidence. Two
// callers need the answer — the gate reducer and the dispatch path that refuses to
// start reviewers without a freeze — and they report it in different shapes, so what
// they share has to be the judgement rather than a copy of the condition. Written
// twice, one copy becomes `available === false` and stops seeing the document that
// never got the field at all.

// Zero IO on purpose: the input is a parsed document, so the dispatch path does not
// have to import the gate's filesystem layer to ask one question.
export function changesetUsable(changesetDocument) {
  if (
    changesetDocument === null ||
    typeof changesetDocument !== "object" ||
    Array.isArray(changesetDocument)
  ) {
    return { usable: false, reason: "changeset_missing" };
  }
  if (changesetDocument.available !== true) {
    return { usable: false, reason: "changeset_unavailable" };
  }
  return { usable: true, reason: null };
}

// Whether this run needs a freeze at all, which is a different question from whether
// the freeze it has is good. An unknown or absent review type resolves to the stricter
// side: otherwise one unrecognised string switches the requirement off.
export function changesetRequired(reviewType) {
  return reviewType !== "full-project";
}
