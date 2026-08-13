/**
 * Plain-language explanations for the HTTP status codes the Power BI, Fabric, Graph
 * and Azure Resource Manager APIs return. The raw message from those APIs is often
 * a bare code such as "Unauthorized", which does not tell an operator what to do,
 * so every surfaced error is paired with an explanation and a suggested next step.
 */
const STATUS_EXPLANATIONS = {
  400: {
    title: 'Bad Request',
    explanation: 'The server could not understand the request because it was malformed or contained invalid values.',
    hint: 'Usually a wrong ID format or an unsupported parameter. Check that the workspace, capacity or item ID is a valid GUID.',
  },
  401: {
    title: 'Unauthorized',
    explanation: 'The request carried no valid credentials, so the service refused to identify the caller.',
    hint: 'The access token is missing, expired, or was issued for the wrong tenant. Re-check the service principal secret in Settings.',
  },
  403: {
    title: 'Forbidden',
    explanation: 'The caller was identified successfully but is not allowed to perform this operation.',
    hint: 'The service principal lacks the required role. Workspace operations need the Admin role on that workspace; tenant reads need "Service principals can use read-only admin APIs" enabled in the Fabric admin portal.',
  },
  404: {
    title: 'Not Found',
    explanation: 'The requested resource does not exist, or is not visible to this caller.',
    hint: 'The workspace or item may already have been deleted, or the service principal cannot see it. Refresh the workspace status.',
  },
  405: {
    title: 'Method Not Allowed',
    explanation: 'The endpoint exists but does not accept this kind of request.',
    hint: 'Usually means the API version or route changed. This is an application bug worth reporting.',
  },
  409: {
    title: 'Conflict',
    explanation: 'The request clashed with the current state of the resource.',
    hint: 'Something else may be modifying the same resource, or the resource is in a state that blocks this operation (for example a capacity that is already paused).',
  },
  413: {
    title: 'Payload Too Large',
    explanation: 'The request body exceeded the size the service accepts.',
    hint: 'Reduce the batch size and try again.',
  },
  415: {
    title: 'Unsupported Media Type',
    explanation: 'The service rejected the content type of the request body.',
    hint: 'An application bug — the request should be sent as JSON.',
  },
  429: {
    title: 'Too Many Requests',
    explanation: 'The service is throttling this caller because too many requests were sent in a short period.',
    hint: 'Power BI and Fabric apply strict per-hour limits. Wait for the period indicated by the Retry-After header, then retry; the app already backs off automatically.',
  },
  500: {
    title: 'Internal Server Error',
    explanation: 'The service hit an unexpected fault while handling the request.',
    hint: 'Not caused by the request itself. Retry after a short wait, and check the Microsoft service health dashboard if it persists.',
  },
  502: {
    title: 'Bad Gateway',
    explanation: 'An upstream service returned an invalid response.',
    hint: 'Usually transient. Retry after a short wait.',
  },
  503: {
    title: 'Service Unavailable',
    explanation: 'The service is temporarily unable to handle the request, typically due to overload or maintenance.',
    hint: 'Retry after a short wait. If it persists, check the Microsoft service health dashboard.',
  },
  504: {
    title: 'Gateway Timeout',
    explanation: 'An upstream service did not respond in time.',
    hint: 'Often seen on large tenant scans. Retry, and consider narrowing the scope of the operation.',
  },
};

const CLASS_FALLBACKS = {
  4: {
    title: 'Request Error',
    explanation: 'The service rejected the request. Codes in the 4xx range mean the problem is with the request or the caller permissions.',
    hint: 'Check the identifiers used and the permissions of the service principal.',
  },
  5: {
    title: 'Service Error',
    explanation: 'The service failed while handling the request. Codes in the 5xx range mean the problem is on the service side.',
    hint: 'Retry after a short wait.',
  },
};

/** Pull an HTTP status code out of an axios error, an Error, or a message string. */
function extractStatus(source) {
  if (source === null || source === undefined) return null;
  if (typeof source === 'number') return Number.isFinite(source) ? source : null;

  if (typeof source === 'object') {
    const direct = source.status || source.statusCode || (source.response && source.response.status);
    if (direct) return Number(direct);
    return extractStatus(source.message);
  }

  // Errors surface as strings such as "API error (403): Forbidden" once they have
  // crossed a JSON response boundary, so recover the code from the text too.
  const match = String(source).match(/\((\d{3})\)|\b(?:status|code)\s*[:=]?\s*(\d{3})\b/i);
  if (!match) return null;
  const code = Number(match[1] || match[2]);
  return code >= 100 && code <= 599 ? code : null;
}

/** Return { status, title, explanation, hint } for a status code, or null. */
function explainStatus(status) {
  const code = extractStatus(status);
  if (!code) return null;
  const known = STATUS_EXPLANATIONS[code];
  if (known) return { status: code, ...known };
  const fallback = CLASS_FALLBACKS[Math.floor(code / 100)];
  return fallback ? { status: code, ...fallback } : null;
}

/** Explain whatever an error handler happens to be holding. */
function explainError(source) {
  return explainStatus(extractStatus(source));
}

/** One-line form, for logs and toasts: "403 Forbidden — the caller ...". */
function describeError(source) {
  const info = explainError(source);
  if (!info) return null;
  return `${info.status} ${info.title} — ${info.explanation}`;
}

module.exports = {
  STATUS_EXPLANATIONS,
  extractStatus,
  explainStatus,
  explainError,
  describeError,
};
