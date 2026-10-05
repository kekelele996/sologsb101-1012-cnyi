/**
 * 停用登记弹窗：登记 / 编辑某台仪器的一段停用与恢复日期。
 * - 恢复日期留空表示还在停用；同一台仪器一年可停用多次，每段单独一条；
 * - 保存「未恢复」段时仪器自动置为已停用，给该段补上恢复日期时自动恢复为在用；
 * - 弹窗内同时列出该仪器既有停用段，可补录恢复、编辑或删除。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  App as AntdApp,
  Button,
  DatePicker,
  Divider,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
} from 'antd';
import { DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useAppDispatch, useAppSelector } from '@/stores/store';
import {
  createDeactivation,
  removeDeactivation,
  selectDeactivations,
  updateDeactivation,
} from '@/stores/deactivationSlice';
import {
  DEACTIVATION_REASON_TEMPLATES,
  deactivationDurationText,
  type Deactivation,
} from '@/types/deactivation';

interface DeactivationFormValues {
  startDate: dayjs.Dayjs | null;
  recoverDate: dayjs.Dayjs | null;
  reason: string;
  remark: string;
}

interface DeactivationModalProps {
  open: boolean;
  instrumentId: string | null;
  /** 仪器显示名（型号 + 序列号），用于弹窗标题 */
  instrumentLabel: string;
  onClose: () => void;
}

export default function DeactivationModal({
  open,
  instrumentId,
  instrumentLabel,
  onClose,
}: DeactivationModalProps) {
  const dispatch = useAppDispatch();
  const { message } = AntdApp.useApp();
  const allDeactivations = useAppSelector(selectDeactivations);
  const [form] = Form.useForm<DeactivationFormValues>();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [recoverMode, setRecoverMode] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const segments = useMemo<Deactivation[]>(
    () =>
      allDeactivations
        .filter((row) => row.instrumentId === instrumentId)
        .sort((a, b) => {
          if (!a.recoverDate && b.recoverDate) return -1;
          if (a.recoverDate && !b.recoverDate) return 1;
          return b.startDate.localeCompare(a.startDate);
        }),
    [allDeactivations, instrumentId]
  );

  useEffect(() => {
    if (!open) return;
    setEditingId(null);
    setRecoverMode(false);
    form.resetFields();
    form.setFieldsValue({
      startDate: dayjs(),
      recoverDate: null,
      reason: DEACTIVATION_REASON_TEMPLATES[0].reason,
      remark: '',
    });
  }, [open, instrumentId, form]);

  const openEdit = (segment: Deactivation) => {
    setEditingId(segment.id);
    setRecoverMode(false);
    form.setFieldsValue({
      startDate: dayjs(segment.startDate),
      recoverDate: segment.recoverDate ? dayjs(segment.recoverDate) : null,
      reason: segment.reason,
      remark: segment.remark,
    });
  };

  /** 对「未恢复」段补恢复日期：默认今天，保存即重新启用 */
  const openRecover = (segment: Deactivation) => {
    setEditingId(segment.id);
    setRecoverMode(true);
    form.setFieldsValue({
      startDate: dayjs(segment.startDate),
      recoverDate: dayjs(),
      reason: segment.reason,
      remark: segment.remark,
    });
  };

  const resetForm = () => {
    setEditingId(null);
    setRecoverMode(false);
    form.setFieldsValue({
      startDate: dayjs(),
      recoverDate: null,
      reason: DEACTIVATION_REASON_TEMPLATES[0].reason,
      remark: '',
    });
  };

  const submit = async () => {
    if (!instrumentId) {
      message.warning('未指定仪器');
      return;
    }
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      const payload = {
        instrumentId,
        startDate: values.startDate ? values.startDate.format('YYYY-MM-DD') : '',
        recoverDate: values.recoverDate ? values.recoverDate.format('YYYY-MM-DD') : '',
        reason: values.reason.trim(),
        remark: values.remark?.trim() ?? '',
      };
      if (editingId) {
        const result = await dispatch(updateDeactivation({ id: editingId, patch: payload })).unwrap();
        message.success(
          result.becomesClosed ? '已登记恢复日期，仪器恢复为在用，标定到期日按停用天数顺延' : '停用登记已更新'
        );
      } else {
        await dispatch(createDeactivation(payload)).unwrap();
        message.success(
          payload.recoverDate
            ? '停用段已登记（已恢复），标定到期日已按停用天数顺延'
            : '已登记停用：停用期间不参与超期统计与按期标定率'
        );
      }
      resetForm();
    } catch (error) {
      message.error(typeof error === 'string' ? error : '停用登记保存失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`停用登记 · ${instrumentLabel}`}
      onCancel={onClose}
      onOk={() => void submit()}
      confirmLoading={submitting}
      okText={recoverMode ? '登记恢复' : editingId ? '保存修改' : '登记停用'}
      width={720}
      destroyOnClose
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Space wrap style={{ marginBottom: 4 }}>
          <Button
            size="small"
            icon={<PlusOutlined />}
            disabled={editingId !== null}
            onClick={resetForm}
          >
            新增一段停用
          </Button>
          <span className="gb-hint">
            同一台仪器一年可停用多次，每段单独记；恢复日期留空表示还在停用，停用期间不参与超期统计与按期标定率。
          </span>
        </Space>
        <Space wrap style={{ marginBottom: 8 }}>
          <span className="gb-hint">停用原因模板：</span>
          {DEACTIVATION_REASON_TEMPLATES.map((template) => (
            <Button
              key={template.key}
              size="small"
              onClick={() => form.setFieldValue('reason', template.reason)}
            >
              {template.reason.slice(0, 8)}…
            </Button>
          ))}
        </Space>
        <Form.Item
          name="reason"
          label="停用原因（清单与提醒页据此展示排除原因）"
          rules={[{ required: true, message: '请填写停用原因' }]}
        >
          <Input maxLength={60} placeholder="如：台站停电 / 断网，暂停观测" />
        </Form.Item>
        <Space size={12} wrap>
          <Form.Item
            name="startDate"
            label="停用日期"
            rules={[{ required: true, message: '请选择停用日期' }]}
            style={{ marginBottom: 8 }}
          >
            <DatePicker
              disabled={recoverMode}
              disabledDate={(date) => date.isAfter(dayjs(), 'day')}
            />
          </Form.Item>
          <Form.Item name="recoverDate" label="恢复日期（空着 = 仍在停用）" style={{ marginBottom: 8 }}>
            <DatePicker
              disabledDate={(date) => date.isAfter(dayjs(), 'day')}
              placeholder="未恢复请留空"
            />
          </Form.Item>
        </Space>
        <Form.Item name="remark" label="备注" style={{ marginBottom: 0 }}>
          <Input.TextArea rows={2} maxLength={100} placeholder="如：设备封存于台站库房，恢复前无需安排外业标定" />
        </Form.Item>
      </Form>

      <Divider style={{ margin: '12px 0' }} orientation="left" plain>
        停用记录（{segments.length} 段）
      </Divider>
      {segments.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="该仪器还没有停用登记"
        />
      ) : (
        <Table
          rowKey="id"
          size="small"
          className="gb-table-compact"
          dataSource={segments}
          pagination={false}
          columns={[
            {
              title: '停用 / 恢复',
              width: 210,
              render: (_: unknown, segment: Deactivation) => (
                <div>
                  <div className="gb-mono">
                    {segment.startDate} ~ {segment.recoverDate || '未恢复'}
                  </div>
                  <div className="gb-hint">{deactivationDurationText(segment)}</div>
                </div>
              ),
            },
            {
              title: '状态',
              width: 90,
              render: (_: unknown, segment: Deactivation) =>
                segment.recoverDate ? <Tag color="green">已恢复</Tag> : <Tag>停用中</Tag>,
            },
            { title: '停用原因', dataIndex: 'reason', ellipsis: true },
            {
              title: '操作',
              width: 210,
              render: (_: unknown, segment: Deactivation) => (
                <Space size={4}>
                  {!segment.recoverDate ? (
                    <Button size="small" type="primary" onClick={() => openRecover(segment)}>
                      登记恢复
                    </Button>
                  ) : null}
                  <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(segment)}>
                    编辑
                  </Button>
                  <Popconfirm
                    title="删除停用段"
                    description="删除后该时段将重新计入标定周期，确认删除？"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() =>
                      void dispatch(removeDeactivation(segment.id))
                        .unwrap()
                        .then(() => {
                          message.success('停用段已删除');
                          if (editingId === segment.id) resetForm();
                        })
                    }
                  >
                    <Button size="small" danger icon={<DeleteOutlined />}>
                      删除
                    </Button>
                  </Popconfirm>
                </Space>
              ),
            },
          ]}
        />
      )}
    </Modal>
  );
}
