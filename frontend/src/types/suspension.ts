/**
 * 仪器停用登记：一台仪器可登记多段停用，每段单独记录。
 * 恢复日期为空串表示仍在停用中。
 *
 * 统计口径（停用跨过原到期日又重新启用的情形）：
 * 停用期间标定周期时钟暂停——恢复后到期日按原到期日顺延停用天数（多段累加），
 * 即停用天数不计入 365 天周期消耗；仍在停用中的仪器不参与超期统计与按期标定率。
 */
import { CALIBRATION_CYCLE_DAYS, daysUntilDue } from '@/types/instrument';

/** 停用登记：仪器某一段停用期的台账 */
export interface Suspension {
  id: string;
  /** 被停用仪器 */
  instrumentId: string;
  /** 停用日期（当天起停用） */
  startDate: string;
  /** 恢复日期（当天恢复启用）；空串表示仍在停用 */
  endDate: string;
  /** 停用原因 */
  reason: string;
  createdAt: number;
  updatedAt: number;
}

/** 停用登记草稿（表单初值） */
export interface SuspensionDraft {
  instrumentId: string;
  startDate: string;
  endDate: string;
  reason: string;
}

export function createEmptySuspensionDraft(instrumentId: string): SuspensionDraft {
  return {
    instrumentId,
    startDate: new Date().toISOString().slice(0, 10),
    endDate: '',
    reason: '',
  };
}

/** 常用停用原因模板 */
export const SUSPENSION_REASON_TEMPLATES: Array<{ key: string; reason: string }> = [
  { key: 'repair', reason: '故障送修，暂停观测' },
  { key: 'lightning', reason: '雷击损坏，待备件更换' },
  { key: 'site', reason: '台站改造或迁建，仪器临时撤收' },
  { key: 'spare', reason: '转为备机，退出日常观测' },
  { key: 'power', reason: '供电或通信中断，长期无数据' },
];

/** 该仪器当前是否有进行中的停用段（恢复日期为空） */
export function activeSuspensionOf(
  suspensions: Suspension[],
  instrumentId: string
): Suspension | null {
  return (
    suspensions.find((row) => row.instrumentId === instrumentId && row.endDate === '') ?? null
  );
}

/** 该仪器是否处于停用中 */
export function isSuspendedNow(suspensions: Suspension[], instrumentId: string): boolean {
  return activeSuspensionOf(suspensions, instrumentId) !== null;
}

/**
 * 基准日（最近一次标定日或安装日）之后落在停用段内的天数，用于顺延到期日。
 * 进行中的停用段按 [停用日, 当前时刻) 计；恢复日期当天恢复启用，不计入停用。
 */
export function suspendedDaysAfter(
  suspensions: Suspension[],
  instrumentId: string,
  baseDate: string,
  now: number = Date.now()
): number {
  const baseTime = Date.parse(`${baseDate}T00:00:00`);
  if (!Number.isFinite(baseTime)) return 0;
  let days = 0;
  suspensions.forEach((row) => {
    if (row.instrumentId !== instrumentId) return;
    const start = Date.parse(`${row.startDate}T00:00:00`);
    if (!Number.isFinite(start)) return;
    const end = row.endDate ? Date.parse(`${row.endDate}T00:00:00`) : now;
    if (!Number.isFinite(end)) return;
    const lo = Math.max(start, baseTime);
    const hi = Math.min(end, now);
    if (hi > lo) days += Math.round((hi - lo) / 86400000);
  });
  return days;
}

/**
 * 停用感知的待标定天数：在 daysUntilDue 基础上顺延基准日之后的停用天数。
 * 正数表示剩余天数，负数表示已超期天数（停用中的仪器请勿据此统计超期）。
 */
export function daysUntilDueExcludingSuspension(
  lastCalibrationDate: string | null,
  installDate: string,
  suspensions: Suspension[],
  instrumentId: string
): number {
  const base = lastCalibrationDate ?? installDate;
  const baseDays = daysUntilDue(lastCalibrationDate, installDate);
  if (!Number.isFinite(Date.parse(`${base}T00:00:00`))) return baseDays;
  return baseDays + suspendedDaysAfter(suspensions, instrumentId, base);
}

/** 该仪器基准日之后累计顺延的停用天数（仅用于展示，0 表示无停用影响） */
export function suspendedShiftDays(
  suspensions: Suspension[],
  instrumentId: string,
  baseDate: string
): number {
  return suspendedDaysAfter(suspensions, instrumentId, baseDate);
}

/** 排除原因文案：仪器清单与更换提醒页标注「为什么不参与统计」 */
export function suspensionExclusionText(active: Suspension | null): string {
  if (!active) return '';
  const reason = active.reason.trim();
  return reason.length > 0
    ? `${active.startDate} 起停用：${reason}，不参与超期统计与按期标定率`
    : `${active.startDate} 起停用，不参与超期统计与按期标定率`;
}

/** 停用段校验：返回错误文案列表（空数组表示通过） */
export function validateSuspension(
  draft: { startDate: string; endDate: string },
  siblings: Suspension[],
  excludeId?: string
): string[] {
  const errors: string[] = [];
  const start = Date.parse(`${draft.startDate}T00:00:00`);
  if (!draft.startDate || !Number.isFinite(start)) {
    errors.push('请填写停用日期');
    return errors;
  }
  let end: number | null = null;
  if (draft.endDate) {
    end = Date.parse(`${draft.endDate}T00:00:00`);
    if (!Number.isFinite(end)) {
      errors.push('恢复日期格式不正确');
      return errors;
    }
    if (end < start) errors.push('恢复日期不能早于停用日期');
  }
  // 同一仪器的停用段不允许重叠（进行中的段视为 [停用日, +∞)）
  const newLo = start;
  const newHi = end ?? Number.POSITIVE_INFINITY;
  siblings.forEach((row) => {
    if (row.id === excludeId) return;
    const rowLo = Date.parse(`${row.startDate}T00:00:00`);
    const rowHi = row.endDate ? Date.parse(`${row.endDate}T00:00:00`) : Number.POSITIVE_INFINITY;
    if (!Number.isFinite(rowLo)) return;
    if (newLo < rowHi && rowLo < newHi) {
      errors.push(`与既有停用段（${row.startDate} ~ ${row.endDate || '至今'}）时间重叠`);
    }
  });
  return errors;
}

/** 停用段展示文案：2025-07-01 ~ 2025-08-01（30 天）/ 2025-07-01 起停用中 */
export function suspensionRangeText(row: Suspension, now: number = Date.now()): string {
  const start = Date.parse(`${row.startDate}T00:00:00`);
  if (!Number.isFinite(start)) return row.startDate;
  const end = row.endDate ? Date.parse(`${row.endDate}T00:00:00`) : now;
  const days = Math.max(0, Math.round((end - start) / 86400000));
  return row.endDate
    ? `${row.startDate} ~ ${row.endDate}（${days} 天）`
    : `${row.startDate} 起停用中（已 ${days} 天）`;
}

/** 标定周期口径说明，供页面提示 */
export const SUSPENSION_CYCLE_TEXT = `停用期间标定周期时钟暂停：恢复后到期日按原到期日顺延停用天数；停用中的仪器不参与超期统计与按期标定率（周期 ${CALIBRATION_CYCLE_DAYS} 天）`;
