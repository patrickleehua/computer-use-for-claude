// The original empty form already means accept/decline. Adding a required enum
// hides consent behind Claude's collapsed field editor and a second submit step.
// Keep the native two-button dialog and deliberately grant only this request.
const TURN_META = 'x-codex-turn-metadata';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function emptyForm(params) {
  const schema = params?.requestedSchema;
  return params?.mode === 'form' && schema?.type === 'object' && record(schema.properties) &&
    Object.keys(schema.properties).length === 0 &&
    (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0)) &&
    Object.keys(schema).every(key => ['type', 'properties', 'required', 'additionalProperties'].includes(key));
}

// Only resource-access gates are automatic, after the Claude host has allowed
// the tool call. Unknown forms and action approvals keep their original flow.
export function automaticAccess(params, { permissionMode, metadata } = {}) {
  if (!['auto', 'bypassPermissions'].includes(permissionMode) || !emptyForm(params)) return null;
  const meta = params._meta;
  if (meta?.codex_approval_kind !== 'mcp_tool_call' || !record(metadata) ||
      !['session_id', 'turn_id', 'call_id'].every(key => typeof metadata[key] === 'string' && metadata[key] && meta[TURN_META]?.[key] === metadata[key])) return null;
  const args = meta.tool_params;
  if (!record(args)) return null;
  if (meta.connector_id === 'browser-use' && meta.tool_name === 'access_browser_origin' &&
      meta.codex_request_type === 'approval_request' && Object.keys(args).length === 1 && args.origin === meta.origin) {
    try {
      const url = new URL(meta.origin);
      if (['http:', 'https:'].includes(url.protocol) && url.origin === meta.origin) return { kind: 'browser_origin' };
    } catch {}
  }
  if (meta.connector_id === 'computer-use' && meta.riskLevel === 'low' &&
      meta.tool_name === undefined && meta.codex_request_type === undefined &&
      Object.keys(args).length === 1 && typeof args.app === 'string' && args.app.trim()) return { kind: 'native_app' };
  return null;
}

export function consentForm(params) {
  const meta = params?._meta;
  if (!emptyForm(params) ||
      meta?.codex_approval_kind !== 'mcp_tool_call' ||
      !['computer-use', 'browser-use'].includes(meta.connector_id)) return null;
  const warning = meta.warningSubtitle || meta.subtitle;
  return {
    request: { ...params, message: [params.message, warning,
      'Accept = 仅允许这一次；Decline = 拒绝；Esc = 取消。不会授予长期权限。',
    ].filter(Boolean).join('\n') },
  };
}
export function consentAnswer(form, response) {
  if (response.action !== 'accept') return { action: response.action === 'decline' ? 'decline' : 'cancel' };
  return { action: 'accept', content: {} };
}
