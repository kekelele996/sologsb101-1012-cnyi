/**
 * 仪器停用登记：一台仪器可分多段停用，每段单独记录。
 * - recoverDate 为空表示当前仍在停用；
 * - 停用期间标定周期「时钟暂停」，恢复后到期日按停用天数顺延（见 scheduledDaysUntilDue）；
 * - 停用中的仪器不参与超期统计与按期标定率，各清单/提醒页须标出排除原因。
 */

/** 停用登记：同一台仪器一年可停用多次，每段一条 */
export interface Deactivation {
  id: string;
  /** 被停用仪器 */
  instrumentId: string;
  /** 停用日期（YYYY-MM-DD，含当日） */
  startDate: string;
  /** 恢复日期（YYYY-MM-DD，含当日）；空串表示尚未恢复、仍在停用 */
  recoverDate: string;
  /** 停用原因（同时作为排除统计时展示的排除原因） */
  reason: string;
  /** 备注 */
  remark: string;
  createdAt: number;
  updatedAt: number;
}

/** 停用登记草稿 */
export interface DeactivationDraft {
  instrumentId: string;
  startDate: string;
  recoverDate: string;
  reason: string;
  remark: string;
}

/** 常用停用原因模板（仪器清单、更换提醒页的排除原因直接取登记原因） */
export const DEACTIVATION_REASON_TEMPLATES: Array<{ key: string; reason: string }> = [
  { key: 'power', reason: '台站停电 / 断网，暂停观测' },
  { key: 'site', reason: '场地改造或汛期避险，设备撤收' },
  { key: 'repair', reason: '仪器返厂维修，暂不观测' },
  { key: 'replace', reason: '雷击等损坏待更换，停用封存' },
  { key: 'loan', reason: '临时借调至其他工区' },
];

export function createEmptyDeactivationDraft(instrumentId = ''): DeactivationDraft {
  return {
    instrumentId,
    startDate: new Date().toISOString().slice(0, 10),
    recoverDate: '',
    reason: DEACTIVATION_REASON_TEMPLATES[0].reason,
    remark: '',
  };
}

/** 日期解析为本地零点时间戳；非法日期返回 NaN */
function parseDay(date: string): number {
  return Date.parse(`${date}T00:00:00`);
}

/** 今天的零点时间戳，保证到期天数按整天计算 */
function todayStart(now: number = Date.now()): number {
  const date = new Date(now);
  return Date.parse(
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate()
    ).padStart(2, '0')}T00:00:00`
  );
}

/** 停用段是否仍在停用中（恢复日期为空即未恢复） */
export function isDeactivationOpen(segment: Pick<Deactivation, 'recoverDate'>): boolean {
  return !segment.recoverDate;
}

/**
 * 该仪器「今天」是否处于停用状态：存在一段停用日期 ≤ 今天且（未恢复或恢复日期 ≥ 今天）的登记。
 * 停用与恢复按整天口径，均含当日。
 */
export function isInstrumentDeactivated(
  segments: Array<Pick<Deactivation, 'startDate' | 'recoverDate'>>,
  now: number = Date.now()
): boolean {
  const today = todayStart(now);
  return segments.some((segment) => {
    const start = parseDay(segment.startDate);
    if (!Number.isFinite(start) || start > today) return false;
    if (!segment.recoverDate) return true;
    const recover = parseDay(segment.recoverDate);
    return Number.isFinite(recover) && recover >= today;
  });
}

/** 当前仍在停用的那一段（未恢复且已开始），无则 null */
export function activeDeactivation<T extends Pick<Deactivation, 'startDate' | 'recoverDate'>>(
  segments: T[],
  now: number = Date.now()
): T | null {
  const today = todayStart(now);
  return (
    segments.find((segment) => {
      const start = parseDay(segment.startDate);
      if (!Number.isFinite(start) || start > today) return false;
      if (!segment.recoverDate) return true;
      return parseDay(segment.recoverDate) >= today;
    }) ?? null
  );
}

/**
 * 统计 [from, to) 半开区间内的停用天数。
 * 各停用段按 [startDate, recoverDate+1天) 与统计区间做整数天交集后求和；
 * 未恢复的停用段截止日期取今天（未来不计停用天数）。
 * 同一天重叠的多段只计一天。
 */
export function countInactiveDays(
  segments: Array<Pick<Deactivation, 'startDate' | 'recoverDate'>>,
  from: number,
  to: number,
  now: number = Date.now()
): number {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return 0;
  const today = todayStart(now);
  const DAY = 86400000;
  const days = new Set<number>();
  segments.forEach((segment) => {
    const start = parseDay(segment.startDate);
    if (!Number.isFinite(start)) return;
    let end: number;
    if (segment.recoverDate) {
      end = parseDay(segment.recoverDate) + DAY; // 恢复当日仍算停用，区间右端 +1 天
    } else {
      end = today + DAY; // 未恢复只计到今天
    }
    if (!Number.isFinite(end)) return;
    const overlapStart = Math.max(start, from);
    const overlapEnd = Math.min(end, to, today + DAY);
    for (let time = overlapStart; time < overlapEnd; time += DAY) {
      days.add(time);
    }
  });
  return days.size;
}

interface InactiveSegment {
  /** 停用起始日零点（含） */
  start: number;
  /** 停用结束日零点的次日（不含），即恢复日 +1 天；未恢复取今天 +1 天 */
  end: number;
}

function normalizeSegments(
  segments: Array<Pick<Deactivation, 'startDate' | 'recoverDate'>>,
  now: number
): InactiveSegment[] {
  const today = todayStart(now);
  const DAY = 86400000;
  return segments
    .map((segment) => {
      const start = parseDay(segment.startDate);
      if (!Number.isFinite(start) || start > today) return null; // 停用日期在未来的段暂不参与顺延
      const end = segment.recoverDate ? parseDay(segment.recoverDate) + DAY : today + DAY;
      if (!Number.isFinite(end) || end <= start) return null;
      return { start, end };
    })
    .filter((segment): segment is InactiveSegment => segment !== null)
    .sort((a, b) => a.start - b.start);
}

/**
 * 考虑停用顺延后，距下次标定的天数：正数为剩余天数，负数为已超期天数。
 *
 * 口径（停用顺延，标定时钟暂停）：标定周期只在「在用日」走动，停用日不消耗周期。
 * 算法沿时间轴逐段扣减：
 *   1. 从起算日起，遇到停用段前的在用日先消耗周期；
 *   2. 停用段整体跳过（时钟暂停），恢复后继续消耗剩余周期；
 *   3. 周期 365 个在用日耗尽之日即有效到期日。
 * 关键约束：只有发生在「周期耗尽之前」的停用段才顺延到期日——已经超期后再停用
 * 不能倒推洗白超期。停用跨过原到期日的，恢复后仍享有完整的剩余在用周期，
 * 班组不必为封存停用的仪器安排外业。停用中的仪器另有排除规则，不进超期统计。
 *
 * @param baseDate 起算日：最近一次标定日期，无标定则为安装日期
 * @param segments 该仪器的全部停用段（可跨年、可多段）
 */
export function scheduledDaysUntilDue(
  baseDate: string,
  segments: Array<Pick<Deactivation, 'startDate' | 'recoverDate'>>,
  cycleDays: number,
  now: number = Date.now()
): number {
  const base = parseDay(baseDate);
  if (!Number.isFinite(base)) return cycleDays;
  const DAY = 86400000;
  let cursor = base;
  let remaining = cycleDays;
  for (const segment of normalizeSegments(segments, now)) {
    const start = Math.max(segment.start, cursor);
    if (segment.end <= cursor) continue; // 已越过的历史停用段
    const activeDays = Math.round((start - cursor) / DAY);
    if (activeDays >= remaining) break; // 周期在该停用段开始前已耗尽，后面停用不再顺延
    remaining -= activeDays;
    cursor = segment.end; // 跳过整个停用段
  }
  const effectiveDue = cursor + remaining * DAY;
  return Math.round((effectiveDue - todayStart(now)) / DAY);
}

/** 排除统计时展示的停用原因文案（仪器清单、更换提醒页共用） */
export function deactivationExcludeReason(
  segment: Pick<Deactivation, 'startDate' | 'recoverDate' | 'reason'> | null
): string {
  if (!segment) return '停用中，停用期间不参与超期统计与按期标定率';
  const range = segment.recoverDate
    ? `${segment.startDate} ~ ${segment.recoverDate}`
    : `${segment.startDate} 起停用，尚未恢复`;
  return `停用排除：${range}｜${segment.reason}`;
}

/** 停用段日期校验，返回错误信息（无错误返回 null） */
export function validateDeactivationDates(
  startDate: string,
  recoverDate: string,
  now: number = Date.now()
): string | null {
  const start = parseDay(startDate);
  if (!Number.isFinite(start)) return '请填写停用日期';
  if (start > todayStart(now)) return '停用日期不能晚于今天';
  if (recoverDate) {
    const recover = parseDay(recoverDate);
    if (!Number.isFinite(recover)) return '恢复日期格式不正确';
    if (recover < start) return '恢复日期不能早于停用日期';
    if (recover > todayStart(now)) return '恢复日期不能晚于今天';
  }
  return null;
}

/**
 * 校验同一台仪器的停用段是否与既有段落时间重叠（停用恢复当天可再次停用，故按整天闭区间比较）。
 * 返回冲突的停用段；excludeId 为当前编辑中的记录 id。
 */
export function findOverlappingDeactivation(
  segments: Array<Pick<Deactivation, 'id' | 'startDate' | 'recoverDate'>>,
  input: Pick<Deactivation, 'startDate' | 'recoverDate'>,
  excludeId?: string,
  now: number = Date.now()
): Deactivation | undefined {
  const today = todayStart(now);
  const inputStart = parseDay(input.startDate);
  const inputEnd = input.recoverDate ? parseDay(input.recoverDate) : today;
  return segments.find((segment) => {
    if (segment.id === excludeId) return false;
    const start = parseDay(segment.startDate);
    if (!Number.isFinite(start)) return false;
    const end = segment.recoverDate ? parseDay(segment.recoverDate) : today;
    return start <= inputEnd && end >= inputStart;
  }) as Deactivation | undefined;
}

/** 停用天数文案：已恢复展示整段天数，未恢复展示截至今天的天数 */
export function deactivationDurationText(
  segment: Pick<Deactivation, 'startDate' | 'recoverDate'>,
  now: number = Date.now()
): string {
  const start = parseDay(segment.startDate);
  if (!Number.isFinite(start)) return '';
  const DAY = 86400000;
  const end = segment.recoverDate ? parseDay(segment.recoverDate) : todayStart(now);
  const days = Math.max(1, Math.round((end - start) / DAY) + 1);
  return segment.recoverDate ? `停用 ${days} 天` : `已停用 ${days} 天，未恢复`;
}
