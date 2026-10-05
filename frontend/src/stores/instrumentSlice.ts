/**
 * 仪器 slice：维护仪器列表、登记草稿与选中台站。
 * 序列号唯一性校验与「登记后自动生成下一次标定待办」在本 slice 的动作里完成。
 * 同时维护仪器停用登记（一台仪器可多段停用，停用状态与仪器档案联动）。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import type { Instrument, InstrumentDraft, InstrumentState, InstrumentType } from '@/types/instrument';
import { createEmptyInstrumentDraft, daysUntilDue } from '@/types/instrument';
import type { Suspension } from '@/types/suspension';
import { validateSuspension } from '@/types/suspension';
import type { RootState } from '@/stores/store';

/** 选择器入参统一用 RootState */
type WithInstrument = RootState;

export interface InstrumentSliceState {
  instruments: Instrument[];
  suspensions: Suspension[];
  ready: boolean;
  error: string | null;
  /** 当前选中的台站（台站仪器页上下文） */
  currentStationId: string | null;
  /** 仪器登记草稿（跨页面保留） */
  draft: InstrumentDraft;
  /** 最近一次保存回执（用于页面提示） */
  lastReceipt: string;
}

const initialState: InstrumentSliceState = {
  instruments: [],
  suspensions: [],
  ready: false,
  error: null,
  currentStationId: null,
  draft: createEmptyInstrumentDraft(),
  lastReceipt: '',
};

/** 序列号唯一性校验：返回冲突的仪器（排除自身） */
export async function findSerialConflict(
  serialNo: string,
  excludeId?: string
): Promise<Instrument | undefined> {
  const rows = await db.instruments.where('serialNo').equals(serialNo).toArray();
  return rows.find((row) => row.id !== excludeId);
}

export const createInstrument = createAsyncThunk(
  'instrument/createInstrument',
  async (
    payload: Omit<Instrument, 'id' | 'createdAt' | 'updatedAt'>,
    { rejectWithValue }
  ) => {
    const conflict = await findSerialConflict(payload.serialNo);
    if (conflict) {
      return rejectWithValue(`序列号「${payload.serialNo}」已被仪器 ${conflict.model} 占用`);
    }
    const now = Date.now();
    const row: Instrument = { ...payload, id: createId('ins'), createdAt: now, updatedAt: now };
    await db.instruments.put(row);
    // 登记后自动生成下一次标定待办：待标定状态 + 提示文案
    const dueInDays = daysUntilDue(null, row.installDate);
    return { row, dueInDays };
  }
);

export const updateInstrument = createAsyncThunk(
  'instrument/updateInstrument',
  async (
    payload: { id: string; patch: Partial<Instrument> },
    { rejectWithValue }
  ) => {
    if (payload.patch.serialNo) {
      const conflict = await findSerialConflict(payload.patch.serialNo, payload.id);
      if (conflict) {
        return rejectWithValue(`序列号「${payload.patch.serialNo}」已被占用`);
      }
    }
    await db.instruments.update(payload.id, { ...payload.patch, updatedAt: Date.now() } as never);
    return payload;
  }
);

/** 删除仪器：级联删除标定、更换与停用记录 */
export const removeInstrument = createAsyncThunk(
  'instrument/removeInstrument',
  async (instrumentId: string) => {
    await db.transaction(
      'rw',
      [db.instruments, db.calibrations, db.replaces, db.suspensions],
      async () => {
        await db.calibrations.where('instrumentId').equals(instrumentId).delete();
        await db.replaces.where('instrumentId').equals(instrumentId).delete();
        await db.suspensions.where('instrumentId').equals(instrumentId).delete();
        await db.instruments.delete(instrumentId);
      }
    );
    return instrumentId;
  }
);

/** 批量改状态（如把超期仪器统一置为待标定） */
export const bulkSetInstrumentState = createAsyncThunk(
  'instrument/bulkSetInstrumentState',
  async (payload: { ids: string[]; state: InstrumentState }) => {
    const now = Date.now();
    await db.instruments
      .where('id')
      .anyOf(payload.ids)
      .modify((row) => {
        row.state = payload.state;
        row.updatedAt = now;
      });
    return payload;
  }
);

/** 更换完成后回写仪器序列号并置为在用 */
export const applySerialReplace = createAsyncThunk(
  'instrument/applySerialReplace',
  async (payload: { instrumentId: string; newSerialNo: string }) => {
    await db.instruments.update(payload.instrumentId, {
      serialNo: payload.newSerialNo,
      state: '在用',
      updatedAt: Date.now(),
    } as never);
    return payload;
  }
);

/* ------------------------------ 停用登记 ------------------------------ */

/**
 * 停用登记与仪器档案状态联动：
 * 存在进行中停用段（恢复日期为空）→ 仪器置「已停用」；全部段均已恢复 → 置回「在用」。
 */
async function syncInstrumentStateBySuspension(instrumentId: string, now: number): Promise<void> {
  const rows = await db.suspensions.where('instrumentId').equals(instrumentId).toArray();
  const hasActive = rows.some((row) => row.endDate === '');
  const instrument = await db.instruments.get(instrumentId);
  if (!instrument) return;
  if (hasActive && instrument.state !== '已停用') {
    await db.instruments.update(instrumentId, { state: '已停用', updatedAt: now } as never);
  } else if (!hasActive && instrument.state === '已停用') {
    await db.instruments.update(instrumentId, { state: '在用', updatedAt: now } as never);
  }
}

/** 登记停用段：恢复日期留空表示仍在停用；同一仪器各段时间不允许重叠 */
export const createSuspension = createAsyncThunk(
  'instrument/createSuspension',
  async (
    payload: Omit<Suspension, 'id' | 'createdAt' | 'updatedAt'>,
    { rejectWithValue }
  ) => {
    const siblings = await db.suspensions
      .where('instrumentId')
      .equals(payload.instrumentId)
      .toArray();
    const errors = validateSuspension(payload, siblings);
    if (errors.length > 0) return rejectWithValue(errors.join('；'));
    const now = Date.now();
    const row: Suspension = { ...payload, id: createId('sus'), createdAt: now, updatedAt: now };
    await db.transaction('rw', [db.suspensions, db.instruments], async () => {
      await db.suspensions.put(row);
      await syncInstrumentStateBySuspension(payload.instrumentId, now);
    });
    return row;
  }
);

/** 编辑停用段（含补登恢复日期） */
export const updateSuspension = createAsyncThunk(
  'instrument/updateSuspension',
  async (
    payload: { id: string; patch: Partial<Pick<Suspension, 'startDate' | 'endDate' | 'reason'>> },
    { rejectWithValue }
  ) => {
    const existing = await db.suspensions.get(payload.id);
    if (!existing) return rejectWithValue('停用记录不存在');
    const next = {
      startDate: payload.patch.startDate ?? existing.startDate,
      endDate: payload.patch.endDate ?? existing.endDate,
    };
    const siblings = await db.suspensions
      .where('instrumentId')
      .equals(existing.instrumentId)
      .toArray();
    const errors = validateSuspension(next, siblings, payload.id);
    if (errors.length > 0) return rejectWithValue(errors.join('；'));
    const now = Date.now();
    await db.transaction('rw', [db.suspensions, db.instruments], async () => {
      await db.suspensions.update(payload.id, { ...payload.patch, updatedAt: now } as never);
      await syncInstrumentStateBySuspension(existing.instrumentId, now);
    });
    return payload;
  }
);

/** 登记恢复：把进行中停用段的恢复日期填为指定日期（默认今天） */
export const resumeSuspension = createAsyncThunk(
  'instrument/resumeSuspension',
  async (payload: { id: string; endDate?: string }, { rejectWithValue }) => {
    const existing = await db.suspensions.get(payload.id);
    if (!existing) return rejectWithValue('停用记录不存在');
    if (existing.endDate !== '') return rejectWithValue('该停用段已登记恢复日期');
    const endDate =
      payload.endDate && payload.endDate.length > 0
        ? payload.endDate
        : new Date().toISOString().slice(0, 10);
    const siblings = await db.suspensions
      .where('instrumentId')
      .equals(existing.instrumentId)
      .toArray();
    const errors = validateSuspension({ startDate: existing.startDate, endDate }, siblings, existing.id);
    if (errors.length > 0) return rejectWithValue(errors.join('；'));
    const now = Date.now();
    await db.transaction('rw', [db.suspensions, db.instruments], async () => {
      await db.suspensions.update(existing.id, { endDate, updatedAt: now } as never);
      await syncInstrumentStateBySuspension(existing.instrumentId, now);
    });
    return { id: existing.id, endDate };
  }
);

/** 删除停用段 */
export const removeSuspension = createAsyncThunk(
  'instrument/removeSuspension',
  async (suspensionId: string, { rejectWithValue }) => {
    const existing = await db.suspensions.get(suspensionId);
    if (!existing) return rejectWithValue('停用记录不存在');
    await db.transaction('rw', [db.suspensions, db.instruments], async () => {
      await db.suspensions.delete(suspensionId);
      await syncInstrumentStateBySuspension(existing.instrumentId, Date.now());
    });
    return suspensionId;
  }
);

const instrumentSlice = createSlice({
  name: 'instrument',
  initialState,
  reducers: {
    setInstruments(state, action: PayloadAction<Instrument[]>) {
      state.instruments = action.payload;
      state.ready = true;
      state.error = null;
    },
    setSuspensions(state, action: PayloadAction<Suspension[]>) {
      state.suspensions = action.payload;
    },
    setInstrumentError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    selectStationForInstrument(state, action: PayloadAction<string | null>) {
      state.currentStationId = action.payload;
      state.draft.stationId = action.payload ?? '';
    },
    patchDraft(state, action: PayloadAction<Partial<InstrumentDraft>>) {
      state.draft = { ...state.draft, ...action.payload };
    },
    resetDraft(state) {
      state.draft = { ...createEmptyInstrumentDraft(), stationId: state.currentStationId ?? '' };
    },
    setReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createInstrument.fulfilled, (state, action) => {
        const dueInDays = action.payload.dueInDays;
        state.lastReceipt =
          dueInDays >= 0
            ? `仪器已登记，距下次标定 ${dueInDays} 天，请按期安排标定`
            : `仪器已登记，但安装日期距今已超过标定周期 ${Math.abs(dueInDays)} 天，请尽快安排标定`;
        state.error = null;
      })
      .addCase(createInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器登记失败';
      })
      .addCase(updateInstrument.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '仪器更新失败';
      })
      .addCase(removeInstrument.fulfilled, (state, action) => {
        state.lastReceipt = `已删除仪器 ${action.payload}`;
      })
      .addCase(createSuspension.fulfilled, (state, action) => {
        state.lastReceipt =
          action.payload.endDate === ''
            ? `停用登记已保存（${action.payload.startDate} 起），停用期间不参与超期统计与按期标定率`
            : `停用段 ${action.payload.startDate} ~ ${action.payload.endDate} 已登记`;
        state.error = null;
      })
      .addCase(createSuspension.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '停用登记失败';
      })
      .addCase(updateSuspension.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '停用记录更新失败';
      })
      .addCase(resumeSuspension.fulfilled, (state, action) => {
        state.lastReceipt = `已登记恢复（${action.payload.endDate}），仪器恢复参与统计，到期日按停用天数顺延`;
        state.error = null;
      })
      .addCase(resumeSuspension.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '恢复登记失败';
      })
      .addCase(removeSuspension.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '停用记录删除失败';
      });
  },
});

export const {
  setInstruments,
  setSuspensions,
  setInstrumentError,
  selectStationForInstrument,
  patchDraft,
  resetDraft,
  setReceipt,
} = instrumentSlice.actions;

let started = false;

/** 启动仪器表与停用登记表实时订阅（幂等） */
export function startInstrumentSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Instrument>(() => db.instruments).subscribe((rows) => {
    dispatch(setInstruments(rows));
  });
  watchTable<Suspension>(() => db.suspensions).subscribe((rows) => {
    dispatch(setSuspensions(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectInstrumentState = (state: WithInstrument): InstrumentSliceState => state.instrument;
export const selectInstruments = (state: WithInstrument): Instrument[] => state.instrument.instruments;
export const selectSuspensions = (state: WithInstrument): Suspension[] => state.instrument.suspensions;
export const selectInstrumentReady = (state: WithInstrument): boolean => state.instrument.ready;
export const selectInstrumentDraft = (state: WithInstrument): InstrumentDraft => state.instrument.draft;
export const selectInstrumentReceipt = (state: WithInstrument): string => state.instrument.lastReceipt;

export const selectInstrumentById = (
  state: WithInstrument,
  id: string | null | undefined
): Instrument | null => (id ? state.instrument.instruments.find((row) => row.id === id) ?? null : null);

/** 指定仪器的停用段（按停用日期升序） */
export const selectSuspensionsOfInstrument = (
  state: WithInstrument,
  instrumentId: string | null | undefined
): Suspension[] => {
  if (!instrumentId) return [];
  return state.instrument.suspensions
    .filter((row) => row.instrumentId === instrumentId)
    .sort((a, b) => a.startDate.localeCompare(b.startDate));
};

export const selectInstrumentsOfStation = (
  state: WithInstrument,
  stationId: string | null | undefined
): Instrument[] => {
  if (!stationId) return [];
  return state.instrument.instruments
    .filter((row) => row.stationId === stationId)
    .sort((a, b) => a.type.localeCompare(b.type, 'zh-Hans-CN') || a.model.localeCompare(b.model));
};

/** 台站 id → 仪器台数 */
export const selectInstrumentCountsByStation = (state: WithInstrument): Record<string, number> => {
  const counts: Record<string, number> = {};
  state.instrument.instruments.forEach((row) => {
    counts[row.stationId] = (counts[row.stationId] ?? 0) + 1;
  });
  return counts;
};

/** 仪器类型统计 */
export const selectInstrumentTypeCounts = (state: WithInstrument): Record<InstrumentType, number> => {
  const counts: Record<InstrumentType, number> = { 宽频带: 0, 短周期: 0, 强震: 0 };
  state.instrument.instruments.forEach((row) => {
    counts[row.type] += 1;
  });
  return counts;
};

export default instrumentSlice.reducer;
