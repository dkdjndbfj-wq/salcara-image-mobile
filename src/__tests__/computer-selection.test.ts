import { readComputerSelection, saveComputerSelection } from '../remote/computer-selection';
import type { ComputerSelection } from '../remote/computer-connections';

const mockRead = jest.fn(), mockWrite = jest.fn();
jest.mock('../storage/database', () => ({ getSetting: (...args: unknown[]) => mockRead(...args), setSetting: (...args: unknown[]) => mockWrite(...args) }));
let saved: string | null;
const relay: ComputerSelection = { kind: 'relay', deviceId: 'computer-a', connectionId: 'a'.repeat(64) };
const bot: ComputerSelection = { kind: 'bot', deviceId: 'computer-b', connectionId: 'b'.repeat(64) };
const direct: ComputerSelection = { kind: 'direct', deviceId: 'computer-c' };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function flush() { for (let i = 0; i < 20; i++) await Promise.resolve(); }
beforeEach(() => {
  saved = null;
  mockRead.mockReset().mockImplementation(async () => saved);
  mockWrite.mockReset().mockImplementation(async (_key: string, value: string | null) => { saved = value; });
});

test.each([relay, bot, direct])('persists the exact non-secret $kind target', async selection => {
  await saveComputerSelection(selection);
  expect(await readComputerSelection()).toEqual(selection);
  expect(JSON.parse(saved!)).toEqual(selection);
  expect(mockWrite).toHaveBeenCalledWith('remote_computer_selection_v1', JSON.stringify(selection));
});

test.each([null, { kind: 'demo', deviceId: 'demo' } as ComputerSelection])('a cleared or demo selection never persists a demo route', async selection => {
  await saveComputerSelection(bot);
  await saveComputerSelection(selection);
  expect(saved).toBeNull(); expect(await readComputerSelection()).toBeNull();
});

test.each([
  'not json', '[]', 'null', JSON.stringify({ kind: 'demo', deviceId: 'demo' }),
  JSON.stringify({ kind: 'relay', deviceId: 'a' }),
  JSON.stringify({ kind: 'bot', deviceId: 'a', connectionId: 'short' }),
  JSON.stringify({ kind: 'direct', deviceId: '../bad' }),
  JSON.stringify({ kind: 'direct', deviceId: 'a', connectionId: 'a'.repeat(64) }),
  JSON.stringify({ ...relay, pairToken: 'secret' }),
  JSON.stringify({ kind: 'unknown', deviceId: 'a' }),
])('rejects malformed or unexpected stored fields: %s', async raw => {
  saved = raw; expect(await readComputerSelection()).toBeNull();
});

test('save rejects credentials and unvalidated routes without writing them', async () => {
  await expect(saveComputerSelection({ ...relay, botToken: 'secret' } as unknown as ComputerSelection)).rejects.toThrow('电脑选择记录无效');
  expect(mockWrite).not.toHaveBeenCalled();
});

test('serialized writes and reads retain the latest choice after an earlier save is delayed', async () => {
  const blocked = deferred<void>();
  mockWrite.mockImplementationOnce(async (_key: string, value: string | null) => { await blocked.promise; saved = value; });
  const first = saveComputerSelection(relay); await flush();
  const second = saveComputerSelection(bot), third = saveComputerSelection(direct), reading = readComputerSelection();
  await flush(); expect(mockWrite).toHaveBeenCalledTimes(1); expect(mockRead).not.toHaveBeenCalled();
  blocked.resolve(); await Promise.all([first, second, third]);
  expect(await reading).toEqual(direct);
  expect(mockWrite.mock.calls.map(call => JSON.parse(call[1]).kind)).toEqual(['relay', 'bot', 'direct']);
});

test('queued writes capture their value and a failed save cannot block later selections', async () => {
  const blocked = deferred<void>();
  mockWrite.mockImplementationOnce(async () => { await blocked.promise; throw new Error('storage busy'); });
  const failed = saveComputerSelection(relay); const rejection = expect(failed).rejects.toThrow('storage busy');
  const target: ComputerSelection = { ...bot }, next = saveComputerSelection(target);
  target.deviceId = 'mutated-after-save';
  blocked.resolve(); await rejection; await next;
  expect(await readComputerSelection()).toEqual(bot);
});
