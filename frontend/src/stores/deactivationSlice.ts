/**
 * 停用 slice：维护仪器停用登记。
 * - 同一台仪器可有多段停用，每段单独一条记录；
 * - 新增「未恢复」段落时把仪器状态置为已停用；
 * - 给未恢复段落补上恢复日期（重新启用）时把仪器状态恢复为在用。
 */
import { createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { db, createId, watchTable } from '@/utils/db';
import {
  findOverlappingDeactivation,
  validateDeactivationDates,
  type Deactivation,
} from '@/types/deactivation';
import type { RootState } from '@/stores/store';

type WithDeactivation = RootState;

export interface DeactivationSliceState {
  deactivations: Deactivation[];
  ready: boolean;
  error: string | null;
  lastReceipt: string;
}

const initialState: DeactivationSliceState = {
  deactivations: [],
  ready: false,
  error: null,
  lastReceipt: '',
};

type DeactivationPayload = Omit<Deactivation, 'id' | 'createdAt' | 'updatedAt'>;

export const createDeactivation = createAsyncThunk(
  'deactivation/createDeactivation',
  async (payload: DeactivationPayload, { rejectWithValue }) => {
    const dateError = validateDeactivationDates(payload.startDate, payload.recoverDate);
    if (dateError) return rejectWithValue(dateError);
    if (!payload.reason.trim()) return rejectWithValue('请填写停用原因');
    const siblings = await db.deactivations
      .where('instrumentId')
      .equals(payload.instrumentId)
      .toArray();
    const conflict = findOverlappingDeactivation(siblings, payload);
    if (conflict) {
      return rejectWithValue(
        `与既有停用登记（${conflict.startDate}${conflict.recoverDate ? ` ~ ${conflict.recoverDate}` : ' 起未恢复'}）时间重叠`
      );
    }
    const now = Date.now();
    const row: Deactivation = {
      ...payload,
      reason: payload.reason.trim(),
      remark: payload.remark.trim(),
      id: createId('dea'),
      createdAt: now,
      updatedAt: now,
    };
    await db.transaction('rw', [db.deactivations, db.instruments], async () => {
      await db.deactivations.put(row);
      // 未恢复 = 当前仍在停用：同步仪器状态，仪器清单与提醒页据此一致
      if (!row.recoverDate) {
        await db.instruments.update(row.instrumentId, { state: '已停用', updatedAt: now } as never);
      }
    });
    return { row };
  }
);

export const updateDeactivation = createAsyncThunk(
  'deactivation/updateDeactivation',
  async (payload: { id: string; patch: Partial<DeactivationPayload> }, { rejectWithValue }) => {
    const existing = await db.deactivations.get(payload.id);
    if (!existing) return rejectWithValue('停用登记不存在');
    const next = { ...existing, ...payload.patch };
    const dateError = validateDeactivationDates(next.startDate, next.recoverDate);
    if (dateError) return rejectWithValue(dateError);
    if (!next.reason.trim()) return rejectWithValue('请填写停用原因');
    const siblings = await db.deactivations
      .where('instrumentId')
      .equals(existing.instrumentId)
      .toArray();
    const conflict = findOverlappingDeactivation(siblings, next, existing.id);
    if (conflict) {
      return rejectWithValue(
        `与既有停用登记（${conflict.startDate}${conflict.recoverDate ? ` ~ ${conflict.recoverDate}` : ' 起未恢复'}）时间重叠`
      );
    }
    const now = Date.now();
    const wasOpen = !existing.recoverDate;
    const becomesClosed = wasOpen && Boolean(next.recoverDate);
    const becomesOpen = !wasOpen && !next.recoverDate;
    await db.transaction('rw', [db.deactivations, db.instruments], async () => {
      await db.deactivations.update(payload.id, {
        ...payload.patch,
        reason: next.reason.trim(),
        remark: next.remark.trim(),
        updatedAt: now,
      } as never);
      // 补上恢复日期 = 重新启用；清空恢复日期 = 重新置为停用
      if (becomesClosed || becomesOpen) {
        await db.instruments.update(existing.instrumentId, {
          state: becomesClosed ? '在用' : '已停用',
          updatedAt: now,
        } as never);
      }
    });
    return { id: payload.id, becomesClosed };
  }
);

export const removeDeactivation = createAsyncThunk(
  'deactivation/removeDeactivation',
  async (id: string) => {
    await db.deactivations.delete(id);
    return id;
  }
);

const deactivationSlice = createSlice({
  name: 'deactivation',
  initialState,
  reducers: {
    setDeactivations(state, action: PayloadAction<Deactivation[]>) {
      state.deactivations = action.payload;
      state.ready = true;
      state.error = null;
    },
    setDeactivationError(state, action: PayloadAction<string | null>) {
      state.error = action.payload;
    },
    setDeactivationReceipt(state, action: PayloadAction<string>) {
      state.lastReceipt = action.payload;
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(createDeactivation.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '停用登记失败';
      })
      .addCase(updateDeactivation.rejected, (state, action) => {
        state.error = typeof action.payload === 'string' ? action.payload : '停用登记更新失败';
      });
  },
});

export const { setDeactivations, setDeactivationError, setDeactivationReceipt } =
  deactivationSlice.actions;

let started = false;

/** 启动停用表实时订阅（幂等） */
export function startDeactivationSubscription(dispatch: (action: unknown) => void): void {
  if (started) return;
  started = true;
  watchTable<Deactivation>(() => db.deactivations).subscribe((rows) => {
    dispatch(setDeactivations(rows));
  });
}

/* ------------------------------ Selector ------------------------------ */

export const selectDeactivationState = (state: WithDeactivation): DeactivationSliceState =>
  state.deactivation;
export const selectDeactivations = (state: WithDeactivation): Deactivation[] =>
  state.deactivation.deactivations;
export const selectDeactivationReady = (state: WithDeactivation): boolean =>
  state.deactivation.ready;

/** 按仪器聚合停用段（停用日期降序；未恢复段落排在最前） */
export const selectDeactivationsByInstrument = (
  state: WithDeactivation
): Map<string, Deactivation[]> => {
  const map = new Map<string, Deactivation[]>();
  state.deactivation.deactivations.forEach((row) => {
    const list = map.get(row.instrumentId) ?? [];
    list.push(row);
    map.set(row.instrumentId, list);
  });
  map.forEach((list) =>
    list.sort((a, b) => {
      if (!a.recoverDate && b.recoverDate) return -1;
      if (a.recoverDate && !b.recoverDate) return 1;
      return b.startDate.localeCompare(a.startDate);
    })
  );
  return map;
};

export default deactivationSlice.reducer;
