import { approvalResultUncertain } from '../remote/approval-result';
import { HubError } from '../remote/client';
import { DirectApiError } from '../remote/direct-api';

test.each([
  new Error('false'), new HubError('Unknown outcome', 200), new HubError('Future response', 200, 'new_future_code'),
  new HubError('Lost response', 200, 'command_delivery_uncertain'),
  new HubError('Old identity', 409, 'request_id_conflict'),
  new DirectApiError('remote', 'Unknown result'),
  new DirectApiError('remote', 'Future result', 'new_future_code'),
  new DirectApiError('remote', 'Lost response', 'command_delivery_uncertain'),
])('unconfirmed approval remains locked: %s', error => expect(approvalResultUncertain(error)).toBe(true));

test.each(['approval_not_sent', 'approval_rejected', 'computer_offline', 'approval_not_pending', 'approval_decision_unsupported'])
('authoritative %s permits correcting the original choice', code => {
  expect(approvalResultUncertain(new HubError('Rejected', 200, code))).toBe(false);
  expect(approvalResultUncertain(new DirectApiError('remote', 'Rejected', code))).toBe(false);
});

test('a remote uncertainty code cannot be disguised by an HTTP rejection status', () => {
  expect(approvalResultUncertain({ status: 400, remoteCode: 'command_delivery_uncertain' })).toBe(true);
});
