import assert from "node:assert/strict";
import test from "node:test";
import { changesetRequired, changesetUsable } from "../../../src/core/changeset-usability.mjs";

test("a frozen changeset that reports itself available is usable", () => {
  assert.deepEqual(changesetUsable({ schemaVersion: 1, available: true }), {
    usable: true,
    reason: null
  });
});

// The whole point of the predicate is that this is `available !== true` and not
// `available === false`. A document that never got the field is not a document that
// says the freeze worked.
test("anything other than a literal available true is not usable", () => {
  for (const document of [
    { schemaVersion: 1, available: false, reason: "git is unavailable" },
    { schemaVersion: 1 },
    { schemaVersion: 1, available: "true" },
    { schemaVersion: 1, available: 1 }
  ]) {
    assert.deepEqual(changesetUsable(document), {
      usable: false,
      reason: "changeset_unavailable"
    });
  }
});

test("a missing or non-document input is reported separately from an unavailable freeze", () => {
  for (const input of [null, undefined, "changeset.json", 7, []]) {
    assert.deepEqual(changesetUsable(input), { usable: false, reason: "changeset_missing" });
  }
});

// Both layers ask this before asking whether the document is usable, so an unknown or
// absent review type has to land on the stricter side. Treating it as full-project
// would let one unrecognised string switch the freeze requirement off.
test("only an explicit full-project review type drops the frozen changeset requirement", () => {
  assert.equal(changesetRequired("changeset"), true);
  assert.equal(changesetRequired(undefined), true);
  assert.equal(changesetRequired(null), true);
  assert.equal(changesetRequired(""), true);
  assert.equal(changesetRequired("Full-Project"), true);
  assert.equal(changesetRequired("something-new"), true);
  assert.equal(changesetRequired("full-project"), false);
});
