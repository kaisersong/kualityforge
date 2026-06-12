export function readOption(args, name) {
  const index = args.indexOf(name);
  if (index === -1) {
    return null;
  }
  return args[index + 1] || null;
}

export function readOptions(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) {
      values.push(args[index + 1]);
      index += 1;
    }
  }
  return values;
}

export function readContextOptions(args) {
  const projectRoot = readOption(args, "--project-root");
  const docsRoots = readOptions(args, "--docs-root");
  const qualityPrinciplesPath = readOption(args, "--quality-principles");
  const changeGoal = readOption(args, "--change-goal");
  const instructionFiles = readOptions(args, "--instruction");
  const designEntrypoints = readOptions(args, "--design-entrypoint");
  const diffBase = readOption(args, "--diff-base");
  const diffHead = readOption(args, "--diff-head");
  const diffMaxPatchBytesText = readOption(args, "--diff-max-patch-bytes");
  const changeset = buildChangesetOptions(diffBase, diffHead, diffMaxPatchBytesText);
  const enableStructureScan = args.includes("--enable-structure-scan");
  const reviewType = readOption(args, "--review-type");

  if (
    !projectRoot &&
    docsRoots.length === 0 &&
    !qualityPrinciplesPath &&
    !changeGoal &&
    instructionFiles.length === 0 &&
    designEntrypoints.length === 0 &&
    !changeset &&
    !enableStructureScan &&
    !reviewType
  ) {
    return null;
  }

  return {
    projectRoot,
    docsRoots,
    qualityPrinciplesPath,
    changeGoal,
    instructionFiles,
    designEntrypoints,
    ...(changeset ? { changeset } : {}),
    ...(enableStructureScan ? { enableStructureScan } : {}),
    ...(reviewType ? { reviewType } : {})
  };
}

function buildChangesetOptions(base, head, maxPatchBytesText) {
  const changeset = {};
  if (base) {
    changeset.base = base;
  }
  if (head) {
    changeset.head = head;
  }
  if (maxPatchBytesText !== null && maxPatchBytesText !== undefined) {
    const maxPatchBytes = Number(maxPatchBytesText);
    if (!Number.isFinite(maxPatchBytes) || maxPatchBytes <= 0) {
      throw new Error("--diff-max-patch-bytes must be a positive number");
    }
    changeset.maxPatchBytes = maxPatchBytes;
  }
  return Object.keys(changeset).length > 0 ? changeset : null;
}

export function requireOption(args, name, commandName) {
  const value = readOption(args, name);
  if (!value) {
    throw new Error(`${commandName} requires ${name} <value>`);
  }
  return value;
}

export function parseCheckOption(value) {
  const separator = value.indexOf("=");
  if (separator === -1) {
    throw new Error("--check must use <name>=<status>");
  }

  return {
    name: value.slice(0, separator),
    status: value.slice(separator + 1)
  };
}

export function parseAgentOptions(values) {
  const result = [];
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator === -1) {
      result.push({ name: value, path: null });
    } else {
      result.push({ name: value.slice(0, separator), path: value.slice(separator + 1) });
    }
  }
  return result;
}

export function parseKeyValueOptions(values, name) {
  const result = new Map();
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator === -1) {
      throw new Error(`${name} must use <key>=<value>`);
    }
    result.set(value.slice(0, separator), value.slice(separator + 1));
  }
  return result;
}

export function buildReviewPolicy(requiredReviewers, advisoryReviewers, quorumMinText) {
  const advisory = dedupe(advisoryReviewers || []);
  const required = dedupe(requiredReviewers || []);
  const hasQuorum = quorumMinText !== null && quorumMinText !== undefined;
  if (advisory.length === 0 && !hasQuorum) {
    return null;
  }
  for (const runnerId of advisory) {
    if (required.includes(runnerId)) {
      throw new Error(`--advisory-reviewer ${runnerId} cannot downgrade a required reviewer`);
    }
  }
  const mode = hasQuorum ? "quorum" : "required_all";
  const review = {
    mode,
    requiredReviewers: required,
    advisoryReviewers: advisory
  };
  if (mode === "quorum") {
    review.quorumMembers = [...required, ...advisory];
    review.quorumMin = Number(quorumMinText);
  }
  return review;
}

function dedupe(values) {
  const out = [];
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (trimmed && !out.includes(trimmed)) {
      out.push(trimmed);
    }
  }
  return out;
}
