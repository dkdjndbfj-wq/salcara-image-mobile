import { requireOptionalNativeModule } from 'expo';
import { Linking, Share } from 'react-native';

import { createId } from '../domain-utils';
import type { PhoneAction, PhoneActionKind } from './types';

/**
 * Phone actions are never executed by the model. The tool only prepares a
 * validated card; the user taps it, and even then the system Clock, Calendar,
 * Messages, Mail, Phone or Maps app opens for a final confirmation.
 */

interface ActionsNative {
  setAlarm(hour: number, minutes: number, message: string, days: number[], skipUi: boolean): Promise<boolean>;
  setTimer(seconds: number, message: string, skipUi: boolean): Promise<boolean>;
  insertEvent(title: string, begin: number, end: number, allDay: boolean, location: string, description: string): Promise<boolean>;
}

function native(): ActionsNative {
  const module = requireOptionalNativeModule<ActionsNative>('SalcaraActions');
  if (!module) throw new Error('当前安装包不支持这个操作，请更新到最新版本');
  return module;
}

export class ActionInputError extends Error {
  constructor(message: string) { super(message); this.name = 'ActionInputError'; }
}

const KINDS: PhoneActionKind[] = ['alarm', 'timer', 'calendar', 'sms', 'email', 'call', 'map', 'open_url', 'share_text'];
const DAY_NAMES = ['', '一', '二', '三', '四', '五', '六', '日'];
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

const str = (value: unknown, max = 500) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const multiline = (value: unknown, max = 4000) => (typeof value === 'string' ? value.trim().slice(0, max) : '');
const pad = (value: number) => String(value).padStart(2, '0');

/** "7:30", "07:30", "19点半" → [hour, minute]. */
export function parseClock(value: string): [number, number] | null {
  const text = value.trim().replace('：', ':');
  let match = text.match(/^(\d{1,2}):(\d{2})$/);
  if (match) {
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    return hour <= 23 && minute <= 59 ? [hour, minute] : null;
  }
  match = text.match(/^(\d{1,2})\s*(?:点|时)\s*(半|(\d{1,2})\s*分?)?$/);
  if (match) {
    const hour = Number(match[1]);
    const minute = match[2] === '半' ? 30 : match[3] ? Number(match[3]) : 0;
    return hour <= 23 && minute <= 59 ? [hour, minute] : null;
  }
  return null;
}

/** "2026-10-01T14:30" or "2026-10-01" (all day), in local time. */
export function parseLocalDateTime(value: string): { date: Date; allDay: boolean } | null {
  const text = value.trim().replace(' ', 'T');
  // A time with an explicit offset (2026-10-01T06:30:00Z / +08:00) is converted to local time.
  if (/T\d{1,2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? null : { date, allDay: false };
  }
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:T(\d{1,2}):(\d{2})(?::\d{2})?)?$/);
  if (!match) return null;
  if (match[4] !== undefined && (Number(match[4]) > 23 || Number(match[5]) > 59)) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const allDay = match[4] === undefined;
  const date = new Date(year, month - 1, day, allDay ? 0 : Number(match[4]), allDay ? 0 : Number(match[5]));
  if (Number.isNaN(date.getTime()) || date.getMonth() !== month - 1 || date.getDate() !== day) return null;
  return { date, allDay };
}

export function describeDate(date: Date, allDay: boolean, now = new Date()): string {
  const sameYear = date.getFullYear() === now.getFullYear();
  const head = `${sameYear ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月${date.getDate()}日 周${WEEK[date.getDay()]}`;
  return allDay ? `${head} 全天` : `${head} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function describeDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return [hours && `${hours} 小时`, minutes && `${minutes} 分钟`, rest && `${rest} 秒`].filter(Boolean).join(' ') || `${seconds} 秒`;
}

function describeDays(days: number[]): string {
  if (!days.length) return '';
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return '每天';
  if (sorted.join() === '1,2,3,4,5') return '工作日';
  if (sorted.join() === '6,7') return '周末';
  return `每周${sorted.map((day) => DAY_NAMES[day]).join('、')}`;
}

function phone(value: unknown): string {
  const text = str(value, 40);
  if (!text) return '';
  if (!/^\+?[\d\s()-]{3,25}$/.test(text)) throw new ActionInputError('电话号码格式不正确');
  return text.replace(/[\s()-]/g, '');
}

/** Validates the model's arguments and builds a card. Throws ActionInputError with a message for the model. */
export function createPhoneAction(input: Record<string, unknown>, now = new Date()): PhoneAction {
  const kind = str(input.action, 20) as PhoneActionKind;
  if (!KINDS.includes(kind)) throw new ActionInputError(`不支持的操作：${kind || '未填写'}`);
  const base = { id: createId(), kind, status: 'ready' as const };
  switch (kind) {
    case 'alarm': {
      const clock = parseClock(str(input.time, 10));
      if (!clock) throw new ActionInputError('alarm 需要 24 小时制时间，如 "07:30"');
      const days = Array.isArray(input.days) ? [...new Set(input.days.map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7))] : [];
      const label = str(input.title, 60);
      const summary = [`闹钟 ${pad(clock[0])}:${pad(clock[1])}`, describeDays(days), label].filter(Boolean).join(' · ');
      return { ...base, summary, params: { hour: clock[0], minute: clock[1], days, label } };
    }
    case 'timer': {
      const seconds = Math.round(Number(input.seconds));
      if (!Number.isFinite(seconds) || seconds < 1 || seconds > 86_400) throw new ActionInputError('timer 需要 1～86400 之间的秒数');
      const label = str(input.title, 60);
      return { ...base, summary: [`倒计时 ${describeDuration(seconds)}`, label].filter(Boolean).join(' · '), params: { seconds, label } };
    }
    case 'calendar': {
      const title = str(input.title, 120);
      if (!title) throw new ActionInputError('calendar 需要 title');
      const start = parseLocalDateTime(str(input.start, 30));
      if (!start) throw new ActionInputError('calendar 需要 start，格式 "YYYY-MM-DDTHH:MM" 或 "YYYY-MM-DD"');
      const endInput = str(input.end, 30) ? parseLocalDateTime(str(input.end, 30)) : null;
      let end = endInput?.date.getTime() ?? (start.allDay ? start.date.getTime() + 86_400_000 : start.date.getTime() + 3_600_000);
      if (end <= start.date.getTime()) end = start.date.getTime() + (start.allDay ? 86_400_000 : 3_600_000);
      const location = str(input.location, 200);
      const endDate = new Date(end);
      const range = start.allDay ? describeDate(start.date, true, now)
        : `${describeDate(start.date, false, now)}–${endDate.toDateString() === start.date.toDateString() ? `${pad(endDate.getHours())}:${pad(endDate.getMinutes())}` : describeDate(endDate, false, now)}`;
      return {
        ...base, summary: [title, range, location].filter(Boolean).join(' · '),
        params: { title, begin: start.date.getTime(), end, allDay: start.allDay, location, notes: multiline(input.body, 2000) },
      };
    }
    case 'sms': {
      const to = phone(input.to);
      const body = multiline(input.body, 1000);
      if (!body && !to) throw new ActionInputError('sms 需要 to 或 body');
      return { ...base, summary: `短信${to ? `给 ${to}` : ''}${body ? `：${body.slice(0, 40)}${body.length > 40 ? '…' : ''}` : ''}`, params: { to, body } };
    }
    case 'email': {
      const to = str(input.to, 200);
      if (to && !to.split(/[,;，；]/).every((part) => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(part.trim()))) throw new ActionInputError('邮箱地址格式不正确');
      const subject = str(input.subject, 200);
      const body = multiline(input.body, 8000);
      if (!to && !subject && !body) throw new ActionInputError('email 需要 to、subject 或 body');
      return { ...base, summary: `邮件${to ? `给 ${to}` : ''}${subject ? ` · ${subject}` : ''}`, params: { to, subject, body } };
    }
    case 'call': {
      const to = phone(input.to);
      if (!to) throw new ActionInputError('call 需要 to（电话号码）');
      return { ...base, summary: `拨打 ${to}`, params: { to } };
    }
    case 'map': {
      const destination = str(input.destination, 200);
      if (!destination) throw new ActionInputError('map 需要 destination');
      return { ...base, summary: `导航到 ${destination}`, params: { destination } };
    }
    case 'open_url': {
      const url = str(input.url, 2000);
      if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new ActionInputError('open_url 需要完整的 http(s) 网址');
      return { ...base, summary: `打开 ${url.replace(/^https?:\/\//i, '').slice(0, 60)}`, params: { url } };
    }
    case 'share_text': {
      const text = multiline(input.text, 8000);
      if (!text) throw new ActionInputError('share_text 需要 text');
      return { ...base, summary: `分享文字：${text.slice(0, 40)}${text.length > 40 ? '…' : ''}`, params: { text } };
    }
    default:
      throw new ActionInputError('不支持的操作');
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

/** Runs a confirmed action by opening the matching system app. */
export async function runPhoneAction(action: PhoneAction): Promise<void> {
  const p = action.params;
  switch (action.kind) {
    case 'alarm':
      await native().setAlarm(Number(p.hour), Number(p.minute), text(p.label), Array.isArray(p.days) ? p.days : [], false);
      return;
    case 'timer':
      await native().setTimer(Number(p.seconds), text(p.label), false);
      return;
    case 'calendar':
      await native().insertEvent(text(p.title), Number(p.begin), Number(p.end), p.allDay === true, text(p.location), text(p.notes));
      return;
    case 'sms':
      await open(`smsto:${encodeURIComponent(text(p.to))}${p.body ? `?body=${encodeURIComponent(text(p.body))}` : ''}`, '没有找到短信应用');
      return;
    case 'email': {
      const query = [p.subject && `subject=${encodeURIComponent(text(p.subject))}`, p.body && `body=${encodeURIComponent(text(p.body))}`].filter(Boolean).join('&');
      await open(`mailto:${text(p.to).split(/\s*[,;]\s*/).map(encodeURIComponent).join(',')}${query ? `?${query}` : ''}`, '没有找到邮件应用');
      return;
    }
    case 'call':
      // ACTION_DIAL: the dialer opens with the number filled in; the user presses call.
      await open(`tel:${encodeURIComponent(text(p.to))}`, '没有找到拨号应用');
      return;
    case 'map':
      await open(`geo:0,0?q=${encodeURIComponent(text(p.destination))}`, '没有找到地图应用');
      return;
    case 'open_url':
      await open(text(p.url), '没有可以打开网址的应用');
      return;
    case 'share_text':
      await Share.share({ message: text(p.text) });
      return;
    default:
      throw new Error('不支持的操作');
  }
}

async function open(url: string, missing: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    throw new Error(missing);
  }
}

export const ACTION_ICONS: Record<PhoneActionKind, 'alarm' | 'hourglass' | 'calendar' | 'chat' | 'mail' | 'phone' | 'map' | 'globe' | 'share'> = {
  alarm: 'alarm', timer: 'hourglass', calendar: 'calendar', sms: 'chat', email: 'mail', call: 'phone', map: 'map', open_url: 'globe', share_text: 'share',
};

export const ACTION_VERBS: Record<PhoneActionKind, string> = {
  alarm: '设置闹钟', timer: '开始倒计时', calendar: '添加到日历', sms: '写短信', email: '写邮件', call: '拨号', map: '开始导航', open_url: '打开', share_text: '分享',
};
