const DEFAULT_HEADERS = { "content-type": "application/json" };

export function createKswarmHttpClient(options = {}) {
  const baseUrl = normalizeBaseUrl(requireString(options.baseUrl, "baseUrl"));
  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createKswarmHttpClient requires a fetch implementation");
  }
  const headers = { ...DEFAULT_HEADERS, ...(options.headers || {}) };

  async function send(action, method, path, body) {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch (error) {
      throw new KswarmHttpError(action, {
        statusCode: 0,
        error: error instanceof Error ? error.message : String(error)
      });
    }

    const payload = await readJson(response);
    if (!response.ok) {
      throw new KswarmHttpError(action, {
        statusCode: response.status,
        error: payload?.error || `http_${response.status}`,
        payload
      });
    }
    if (payload && payload.ok === false) {
      throw new KswarmHttpError(action, {
        statusCode: response.status,
        error: payload.error || "unknown_error",
        payload
      });
    }
    return payload;
  }

  return {
    baseUrl,
    async createScriptWorkflowProposal(projectId, preview, input = {}) {
      return send(
        "createScriptWorkflowProposal",
        "POST",
        `/projects/${encode(projectId)}/workflows/script-generated/proposal`,
        { preview, ...input }
      );
    },
    async startScriptWorkflowRunFromProposal(projectId, proposalId, input = {}) {
      return send(
        "startScriptWorkflowRunFromProposal",
        "POST",
        `/projects/${encode(projectId)}/workflows/script-generated/runs`,
        { proposalId, ...input }
      );
    },
    async beginWorkflowScriptParallelGroup(projectId, workflowRunId, input = {}) {
      return send(
        "beginWorkflowScriptParallelGroup",
        "POST",
        `/projects/${encode(projectId)}/workflows/${encode(workflowRunId)}/script/parallel-groups`,
        input
      );
    },
    async dispatchWorkflowScriptAgentNode(projectId, workflowRunId, input = {}) {
      return send(
        "dispatchWorkflowScriptAgentNode",
        "POST",
        `/projects/${encode(projectId)}/workflows/${encode(workflowRunId)}/script/nodes`,
        input
      );
    },
    async getWorkflowRun(projectId, workflowRunId) {
      return send(
        "getWorkflowRun",
        "GET",
        `/projects/${encode(projectId)}/workflows/${encode(workflowRunId)}`
      );
    },
    async recordWorkflowNodeResult(projectId, workflowRunId, input = {}) {
      const nodeId = requireString(input.nodeId, "nodeId");
      const { nodeId: _ignored, ...body } = input;
      return send(
        "recordWorkflowNodeResult",
        "POST",
        `/projects/${encode(projectId)}/workflows/${encode(workflowRunId)}/script/nodes/${encode(nodeId)}/result`,
        body
      );
    },
    async completeScriptWorkflowRun(projectId, workflowRunId, input = {}) {
      return send(
        "completeScriptWorkflowRun",
        "POST",
        `/projects/${encode(projectId)}/workflows/${encode(workflowRunId)}/script/complete`,
        input
      );
    }
  };
}

export class KswarmHttpError extends Error {
  constructor(action, { statusCode, error, payload } = {}) {
    super(`${action} failed: ${error || "unknown_error"}`);
    this.name = "KswarmHttpError";
    this.action = action;
    this.statusCode = statusCode;
    this.kswarmError = error;
    this.payload = payload;
  }
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid_json_response", body: text };
  }
}

function normalizeBaseUrl(value) {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function encode(value) {
  return encodeURIComponent(requireString(value, "path segment"));
}

function requireString(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}
