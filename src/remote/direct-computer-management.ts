/** Computer management uses the authenticated, certificate-pinned direct transport only. */
export type ManagementWire = 'auto' | 'responses' | 'chat' | 'anthropic';
export type ManagementAuth = 'bearer' | 'api-key';
export interface ManagementItem { id: string; name: string; role: string; installed: boolean; installable: boolean; version?: string; note?: string }
export interface ManagementJob { id: string; tool: string; state: 'running' | 'done' | 'failed' }
export interface ManagementStatus { supported: true; items: ManagementItem[]; job: ManagementJob | null; discoveryPending: boolean; busy: boolean }
export interface NewComputerApi { name: string; baseUrl: string; key: string; wire: ManagementWire; authMode: ManagementAuth; models: string }
export type ComputerManagementCommand =
  | { type: 'computer.management.status'; controlSurface: 'cli' }
  | { type: 'computer.api.create'; controlSurface: 'cli'; requestId: string; name: string; baseUrl: string; key: string; wire: ManagementWire; authMode: ManagementAuth; models: string[] }
  | { type: 'computer.agent.install'; controlSurface: 'cli'; requestId: string; tool: string; confirmed: true };
export type ComputerManagementTransport = (command: ComputerManagementCommand) => Promise<unknown>;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const label = (value: unknown, maximum = 200): value is string => typeof value === 'string' && value.length <= maximum && !/[\r\n\0]/.test(value);
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value);

export function parseManagementJob(raw: unknown): ManagementJob | undefined {
  if (!record(raw) || !id(raw.id) || !id(raw.tool) || !['running', 'done', 'failed'].includes(String(raw.state))) return undefined;
  // Installer output and raw error text can contain local paths or credentials.
  return { id: raw.id, tool: raw.tool, state: raw.state as ManagementJob['state'] };
}

export function parseManagementStatus(raw: unknown): ManagementStatus | undefined {
  if (!record(raw) || raw.supported !== true || !Array.isArray(raw.items) || raw.items.length > 32 || typeof raw.discoveryPending !== 'boolean'
    || raw.busy !== undefined && typeof raw.busy !== 'boolean') return undefined;
  const items: ManagementItem[] = [], seen = new Set<string>();
  for (const item of raw.items) {
    if (!record(item) || !id(item.id) || seen.has(item.id) || !label(item.name) || !item.name.trim() || !label(item.role, 500)
      || typeof item.installed !== 'boolean' || typeof item.installable !== 'boolean'
      || item.version !== undefined && !label(item.version, 80) || item.note !== undefined && !label(item.note, 500)) return undefined;
    seen.add(item.id);
    items.push({ id: item.id, name: item.name, role: item.role, installed: item.installed, installable: item.installable,
      ...(item.version ? { version: item.version as string } : {}), ...(item.note ? { note: item.note as string } : {}) });
  }
  const job = raw.job === null ? null : parseManagementJob(raw.job);
  return job === undefined ? undefined : { supported: true, items, job, discoveryPending: raw.discoveryPending, busy: raw.busy === true };
}

export function apiCreationConfirmed(raw: unknown): boolean {
  return record(raw) && raw.ok === true && typeof raw.accountId === 'string' && /^api_[a-f0-9]{8,64}$/.test(raw.accountId) && label(raw.name, 160) && Array.from(raw.name).length <= 80;
}

/** Validation errors are fixed local strings and never interpolate a credential. */
export function buildComputerApiCommand(input: NewComputerApi, requestId: string): Extract<ComputerManagementCommand, { type: 'computer.api.create' }> {
  const name = input.name.trim(), baseUrl = input.baseUrl.trim(), key = input.key.trim();
  if (!name || Array.from(name).length > 80 || /[\r\n\0]/.test(name)) throw new Error('请填写 1–80 个字的 API 名称');
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('请填写完整的 API 地址'); }
  if (!['https:', 'http:'].includes(endpoint.protocol) || !endpoint.hostname || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || baseUrl.length > 4096 || /[\s\0]/.test(baseUrl)) throw new Error('API 地址格式无效，请检查协议和路径');
  if (!key || key.length > 8192 || /[\r\n\0]/.test(key)) throw new Error('请填写有效的 API Key');
  if (!['auto', 'responses', 'chat', 'anthropic'].includes(input.wire) || !['bearer', 'api-key'].includes(input.authMode)) throw new Error('请选择有效的接口和认证方式');
  const models = Array.from(new Set(input.models.split(/[\s,，;；]+/).filter(Boolean)));
  if (models.length > 100 || models.some(model => model.length > 200 || /\0/.test(model))) throw new Error('模型目录最多 100 项，请检查模型数量和 ID');
  if (!/^[a-f0-9-]{36}$/i.test(requestId)) throw new Error('无法生成请求编号，请重新打开');
  return { type: 'computer.api.create', controlSurface: 'cli', requestId, name, baseUrl, key, wire: input.wire, authMode: input.authMode, models };
}
