/**
 * useCalibHistory：按仪器聚合历次标定、算灵敏度变化量与待标定天数。
 * 被标定记录台（/calibrations）与更换提醒页（/replacements）消费。
 *
 * 停用口径：
 * - 停用中的仪器 deactivated=true，overdue=false（不参与超期统计与按期标定率），
 *   并带 activeDeactivation 与 excludeReason 供清单/提醒页标出排除原因；
 * - 到期日按停用天数顺延（scheduledDaysUntilDue），停用跨过原到期日恢复后不凭空超期。
 */
import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { selectArrays, selectStations } from '@/stores/arraySlice';
import { selectInstruments } from '@/stores/instrumentSlice';
import { selectCalibrations } from '@/stores/calibrationSlice';
import { selectDeactivations } from '@/stores/deactivationSlice';
import { calibrateDueText, sensitivityDelta, type SensitivityDelta } from '@/types/calibration';
import { CALIBRATION_CYCLE_DAYS } from '@/types/instrument';
import {
  activeDeactivation,
  deactivationExcludeReason,
  scheduledDaysUntilDue,
} from '@/types/deactivation';
import type { Calibration, ResponseVerdict } from '@/types/calibration';
import type { Instrument } from '@/types/instrument';
import type { Deactivation } from '@/types/deactivation';

/** 单台仪器的标定历史聚合 */
export interface InstrumentCalibHistory {
  instrument: Instrument;
  stationCode: string;
  arrayId: string;
  arrayName: string;
  /** 历次标定（按日期降序） */
  calibrations: Calibration[];
  /** 最近一次标定 */
  latest: Calibration | null;
  /** 最近一次灵敏度相对上一次的变化 */
  delta: SensitivityDelta;
  /** 标定次数 */
  count: number;
  /** 全部停用段（按时间降序、未恢复在最前） */
  deactivations: Deactivation[];
  /** 当前生效的停用段（停用中时非空） */
  activeDeactivation: Deactivation | null;
  /** 今天是否处于停用状态 */
  deactivated: boolean;
  /** 停用排除原因文案（停用中时供页面展示） */
  excludeReason: string;
  /**
   * 距下次标定天数（负数为已超期），已按停用天数顺延。
   * 停用中的仪器该值不参与统计，仅做展示参考。
   */
  dueInDays: number;
  /** 是否超期未标定（停用中的仪器恒为 false） */
  overdue: boolean;
  /** 是否处于待标定状态（停用中的仪器不计待标定，不进外业提醒） */
  pending: boolean;
  /** 历次结论中最差的一次 */
  worstVerdict: ResponseVerdict;
  /** 灵敏度序列（由旧到新），供趋势展示 */
  trend: Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

export interface UseCalibHistoryResult {
  histories: InstrumentCalibHistory[];
  historyOf: (instrumentId: string) => InstrumentCalibHistory | null;
  overdueHistories: InstrumentCalibHistory[];
  /** 灵敏度趋势：返回指定仪器的序列 */
  trendOf: (instrumentId: string) => Array<{ date: string; sensitivity: number; selfNoise: number }>;
}

const VERDICT_ORDER: Record<ResponseVerdict, number> = { 合格: 0, 待判定: 1, 不合格: 2 };

/**
 * 组合式 Hook：基于 Redux 中的台阵 / 台站 / 仪器 / 标定 / 停用数据派生标定历史与超期提醒。
 */
export function useCalibHistory(): UseCalibHistoryResult {
  const arrays = useSelector(selectArrays);
  const stations = useSelector(selectStations);
  const instruments = useSelector(selectInstruments);
  const calibrations = useSelector(selectCalibrations);
  const deactivations = useSelector(selectDeactivations);

  const histories = useMemo<InstrumentCalibHistory[]>(() => {
    const deactivationMap = new Map<string, Deactivation[]>();
    deactivations.forEach((deactivation) => {
      const list = deactivationMap.get(deactivation.instrumentId) ?? [];
      list.push(deactivation);
      deactivationMap.set(deactivation.instrumentId, list);
    });
    deactivationMap.forEach((list) =>
      list.sort((a, b) => {
        if (!a.recoverDate && b.recoverDate) return -1;
        if (a.recoverDate && !b.recoverDate) return 1;
        return b.startDate.localeCompare(a.startDate);
      })
    );

    return instruments
      .map((instrument) => {
        const station = stations.find((item) => item.id === instrument.stationId);
        const array = station ? arrays.find((item) => item.id === station.arrayId) : undefined;
        const rows = calibrations
          .filter((calibration) => calibration.instrumentId === instrument.id)
          .sort((a, b) => b.date.localeCompare(a.date));
        const latest = rows.length > 0 ? rows[0] : null;
        const previous = rows.length > 1 ? rows[1] : null;
        const delta = sensitivityDelta(latest?.sensitivity ?? 0, previous ? previous.sensitivity : null);
        const segments = deactivationMap.get(instrument.id) ?? [];
        const active = activeDeactivation(segments);
        const deactivated = active !== null;
        const dueInDays = scheduledDaysUntilDue(
          latest ? latest.date : instrument.installDate,
          segments,
          CALIBRATION_CYCLE_DAYS
        );
        const worstVerdict = rows.reduce<ResponseVerdict>((worst, row) => {
          return VERDICT_ORDER[row.responseVerdict] > VERDICT_ORDER[worst] ? row.responseVerdict : worst;
        }, '合格');
        return {
          instrument,
          stationCode: station?.code ?? '未知台站',
          arrayId: array?.id ?? station?.arrayId ?? '',
          arrayName: array?.name ?? '未知台阵',
          calibrations: rows,
          latest,
          delta,
          count: rows.length,
          deactivations: segments,
          activeDeactivation: active,
          deactivated,
          excludeReason: deactivationExcludeReason(active),
          dueInDays,
          // 停用期间不判超期：封存停用的仪器不进超期统计与外业提醒
          overdue: !deactivated && dueInDays < 0,
          pending: !deactivated && (instrument.state === '待标定' || dueInDays < 0),
          worstVerdict,
          trend: [...rows]
            .reverse()
            .map((row) => ({ date: row.date, sensitivity: row.sensitivity, selfNoise: row.selfNoise })),
        };
      })
      .sort((a, b) => {
        // 停用中的仪器沉底，班组一眼看清哪些才要安排外业
        if (a.deactivated !== b.deactivated) return a.deactivated ? 1 : -1;
        return a.dueInDays - b.dueInDays;
      });
  }, [arrays, calibrations, deactivations, instruments, stations]);

  const historyOf = useCallback(
    (instrumentId: string): InstrumentCalibHistory | null =>
      histories.find((history) => history.instrument.id === instrumentId) ?? null,
    [histories]
  );

  const overdueHistories = useMemo(
    () => histories.filter((history) => history.overdue || history.pending),
    [histories]
  );

  const trendOf = useCallback(
    (instrumentId: string): Array<{ date: string; sensitivity: number; selfNoise: number }> =>
      histories.find((history) => history.instrument.id === instrumentId)?.trend ?? [],
    [histories]
  );

  return { histories, historyOf, overdueHistories, trendOf };
}

/** 标定周期说明文案，供页面提示 */
export const CALIBRATION_CYCLE_TEXT = `标定周期 ${CALIBRATION_CYCLE_DAYS} 天（约 1 年），停用期间时钟暂停、恢复后到期日顺延；超期仪器在更换提醒页高亮`;

/** 待标定天数文案 */
export function dueText(history: InstrumentCalibHistory): string {
  if (history.deactivated) return '停用中，不参与标定周期统计';
  return calibrateDueText(history.dueInDays);
}
