import React from 'react';
import {
  House,
  CheckSquare,
  ArrowsLeftRight,
  Handshake,
  SunHorizon,
  Warning,
  WarningDiamond,
  CalendarDots,
  CalendarCheck,
  CalendarBlank,
  Package,
  FireExtinguisher,
  ChartBar,
  ChatsCircle,
  FlagBanner,
  UsersThree,
  UserCircle,
  User,
  UserGear,
  UserPlus,
  UserSwitch,
  ClipboardText,
  ListChecks,
  ListBullets,
  Signature,
  Siren,
  GearSix,
  Gear,
  Archive,
  Wrench,
  Toolbox,
  ShieldCheck,
  Robot,
  Brain,
  Sparkle,
  MapPin,
  Camera,
  Image,
  QrCode,
  Printer,
  DownloadSimple,
  UploadSimple,
  BellRinging,
  Database,
  FileText,
  FilePdf,
  FileZip,
  MagnifyingGlass,
  Funnel,
  SlidersHorizontal,
  ArrowsClockwise,
  ArrowClockwise,
  Eye,
  EyeSlash,
  Lock,
  LockKeyOpen,
  PencilSimple,
  Trash,
  Plus,
  Minus,
  Check,
  CheckCircle,
  X,
  Buildings,
  Phone,
  Headset,
  SpeakerHigh,
  Clock,
  ClockCounterClockwise,
  type IconProps
} from '@phosphor-icons/react';

export type TransitIconProps = IconProps;

// ==========================================
// 1. 轨道交通与 AFC 专属工控设备专用矢量 SVG
// ==========================================

// 进出站闸机 (AGM Gate)
export const IconAgmGate: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <rect x='3' y='4' width='6' height='16' rx='2' />
    <rect x='15' y='4' width='6' height='16' rx='2' />
    <path d='M9 10l3 2-3 2' />
    <path d='M15 10l-3 2 3 2' />
    <circle cx='6' cy='8' r='1' fill='currentColor' />
    <circle cx='18' cy='8' r='1' fill='currentColor' />
  </svg>
);

// 自动售票机 (TVM)
export const IconTvm: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <rect x='4' y='2' width='16' height='20' rx='2.5' />
    <rect x='7' y='5' width='10' height='6' rx='1' />
    <line x1='7' y1='14' x2='11' y2='14' />
    <line x1='14' y1='14' x2='17' y2='14' />
    <rect x='7' y='17' width='10' height='2.5' rx='0.8' />
  </svg>
);

// 半自动售票机 (BOM)
export const IconBom: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <rect x='3' y='3' width='18' height='12' rx='2' />
    <path d='M7 15v3a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-3' />
    <rect x='6' y='6' width='6' height='6' rx='1' />
    <circle cx='16' cy='9' r='2' />
    <line x1='10' y1='20' x2='14' y2='20' />
  </svg>
);

// 单程票 Token (Transit Smart Token)
export const IconToken: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <circle cx='12' cy='12' r='9' />
    <circle cx='12' cy='12' r='5' strokeDasharray='2 2' />
    <path d='M10 12h4' />
    <path d='M12 10v4' />
  </svg>
);

// 射频读写器 (RFID Reader)
export const IconRfidReader: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <rect x='5' y='6' width='14' height='14' rx='2.5' />
    <path d='M8.5 13a4.5 4.5 0 0 1 7 0' />
    <path d='M10 15a2.5 2.5 0 0 1 4 0' />
    <circle cx='12' cy='17' r='0.8' fill='currentColor' />
    <path d='M9 2h6' />
    <path d='M12 2v4' />
  </svg>
);

// 车站计算机 (SC Workstation)
export const IconStationComputer: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <rect x='3' y='3' width='18' height='12' rx='2' />
    <path d='M8 21h8' />
    <path d='M12 15v6' />
    <path d='M7 8h4' />
    <path d='M7 11h2' />
    <circle cx='16' cy='9.5' r='1.5' />
  </svg>
);

// 清分中心 (LC/ACC Server Cluster)
export const IconServerCluster: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <rect x='3' y='3' width='18' height='5' rx='1.5' />
    <rect x='3' y='10' width='18' height='5' rx='1.5' />
    <rect x='3' y='17' width='18' height='5' rx='1.5' />
    <circle cx='6' cy='5.5' r='1' fill='currentColor' />
    <circle cx='6' cy='12.5' r='1' fill='currentColor' />
    <circle cx='6' cy='19.5' r='1' fill='currentColor' />
    <line x1='16' y1='5.5' x2='18' y2='5.5' />
    <line x1='16' y1='12.5' x2='18' y2='12.5' />
    <line x1='16' y1='19.5' x2='18' y2='19.5' />
  </svg>
);

// 变电所与 UPS (Power Station UPS)
export const IconUpsPower: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <rect x='4' y='6' width='16' height='15' rx='2' />
    <line x1='8' y1='2' x2='8' y2='6' />
    <line x1='16' y1='2' x2='16' y2='6' />
    <path d='M12 9l-2 4h4l-2 5' />
  </svg>
);

// 工业交换机 (Network Switch)
export const IconIndustrialSwitch: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <rect x='2' y='6' width='20' height='12' rx='2' />
    <circle cx='6' cy='12' r='1.5' />
    <circle cx='10' cy='12' r='1.5' />
    <circle cx='14' cy='12' r='1.5' />
    <circle cx='18' cy='12' r='1.5' />
  </svg>
);

// 手持 POS 终端 (Handheld POS)
export const IconPosTerminal: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <rect x='6' y='2' width='12' height='20' rx='2.5' />
    <rect x='9' y='5' width='6' height='4' rx='0.8' />
    <circle cx='9' cy='12' r='0.8' fill='currentColor' />
    <circle cx='12' cy='12' r='0.8' fill='currentColor' />
    <circle cx='15' cy='12' r='0.8' fill='currentColor' />
    <circle cx='9' cy='15' r='0.8' fill='currentColor' />
    <circle cx='12' cy='15' r='0.8' fill='currentColor' />
    <circle cx='15' cy='15' r='0.8' fill='currentColor' />
    <rect x='9' y='18' width='6' height='1.5' rx='0.5' />
  </svg>
);

// 车站拓扑网络 (Station Topology Map)
export const IconStationNetwork: React.FC<TransitIconProps> = ({ size = 24, className = '', ...props }) => (
  <svg width={size} height={size} viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' className={className} {...props}>
    <circle cx='6' cy='6' r='3' />
    <circle cx='18' cy='6' r='3' />
    <circle cx='12' cy='18' r='3' />
    <line x1='8.6' y1='7.3' x2='15.4' y2='7.3' />
    <line x1='7.5' y1='8.6' x2='10.5' y2='15.4' />
    <line x1='16.5' y1='8.6' x2='13.5' y2='15.4' />
  </svg>
);

// ==========================================
// 2. 导出所有系统与工控 SVG 图标字典定义
// ==========================================

export interface TransitIconItem {
  id: string;
  name: string;
  nameEn: string;
  category: 'core' | 'devices' | 'ops' | 'system';
  component: React.ComponentType<any>;
  tags: string[];
}

export const TRANSIT_ICON_LIST: TransitIconItem[] = [
  // --- 核心业务导航与功能入口 (系统真实图标) ---
  { id: 'fire-extinguisher', name: '灭火器管理', nameEn: 'FireExtinguisher', category: 'core', component: FireExtinguisher, tags: ['灭火器', '消防', '安全', '巡检'] },
  { id: 'sun-horizon', name: '班前晨会', nameEn: 'SunHorizon', category: 'core', component: SunHorizon, tags: ['晨会', '早会', '交底', '出勤'] },
  { id: 'arrows-left-right', name: '交接班', nameEn: 'ArrowsLeftRight', category: 'core', component: ArrowsLeftRight, tags: ['交接班', '换班', '值班'] },
  { id: 'handshake', name: '交接确认', nameEn: 'Handshake', category: 'core', component: Handshake, tags: ['签字', '确认', '交接'] },
  { id: 'warning-diamond', name: '隐患提报', nameEn: 'WarningDiamond', category: 'core', component: WarningDiamond, tags: ['隐患', '风险', '提报', '安全'] },
  { id: 'warning', name: '故障管理', nameEn: 'Warning', category: 'core', component: Warning, tags: ['故障', '报警', '报修'] },
  { id: 'calendar-dots', name: '检修排产', nameEn: 'CalendarDots', category: 'core', component: CalendarDots, tags: ['检修', '排产', '日历', '计划'] },
  { id: 'package', name: '物料管理', nameEn: 'Package', category: 'core', component: Package, tags: ['物料', '备件', '物资', '库存'] },
  { id: 'chats-circle', name: '班组议事厅', nameEn: 'ChatsCircle', category: 'core', component: ChatsCircle, tags: ['议事厅', '讨论', '留言', '沟通'] },
  { id: 'flag-banner', name: '党建管理', nameEn: 'FlagBanner', category: 'core', component: FlagBanner, tags: ['党建', '旗帜', '活动'] },
  { id: 'users-three', name: '人员管理', nameEn: 'UsersThree', category: 'core', component: UsersThree, tags: ['人员', '班组', '成员', '工班'] },
  { id: 'clipboard-text', name: '演练与凭证', nameEn: 'ClipboardText', category: 'core', component: ClipboardText, tags: ['演练', '记录', '表单', '收集表'] },
  { id: 'signature', name: '电子签字', nameEn: 'Signature', category: 'core', component: Signature, tags: ['签字', '签名', '电子签名', '手写'] },
  { id: 'siren', name: '应急演练', nameEn: 'Siren', category: 'core', component: Siren, tags: ['应急', '演练', '警报'] },
  { id: 'gear-six', name: '参数管理', nameEn: 'GearSix', category: 'core', component: GearSix, tags: ['设置', '参数', '系统管理'] },
  { id: 'house', name: '运行总览', nameEn: 'House', category: 'core', component: House, tags: ['首页', '工作台', '总览'] },
  { id: 'check-square', name: '待办事项', nameEn: 'CheckSquare', category: 'core', component: CheckSquare, tags: ['待办', '任务', '清单'] },
  { id: 'chart-bar', name: '工作量填报', nameEn: 'ChartBar', category: 'core', component: ChartBar, tags: ['统计', '工作量', '图表'] },
  { id: 'archive', name: '历史归档', nameEn: 'Archive', category: 'core', component: Archive, tags: ['归档', '记录', '历史'] },

  // --- 轨道交通与 AFC 专属硬件设备 ---
  { id: 'agm-gate', name: '进出站闸机', nameEn: 'IconAgmGate', category: 'devices', component: IconAgmGate, tags: ['闸机', '检票', '扇门', '通道', 'AGM'] },
  { id: 'tvm', name: '自动售票机', nameEn: 'IconTvm', category: 'devices', component: IconTvm, tags: ['售票机', '购票', '充值', '硬币', 'TVM'] },
  { id: 'bom', name: '半自动售票机', nameEn: 'IconBom', category: 'devices', component: IconBom, tags: ['补票', '客服中心', '人工售票', 'BOM'] },
  { id: 'smart-token', name: '单程票Token', nameEn: 'IconToken', category: 'devices', component: IconToken, tags: ['车票', '单程票', '芯片', 'Token'] },
  { id: 'rfid-reader', name: '射频读写器', nameEn: 'IconRfidReader', category: 'devices', component: IconRfidReader, tags: ['读卡器', '天线', '刷卡区', '感应'] },
  { id: 'sc-workstation', name: '车站计算机SC', nameEn: 'IconStationComputer', category: 'devices', component: IconStationComputer, tags: ['SC', '工作站', '车站监控'] },
  { id: 'server-cluster', name: '清分中心LC/ACC', nameEn: 'IconServerCluster', category: 'devices', component: IconServerCluster, tags: ['服务器', '中心', '清分', '机房'] },
  { id: 'handheld-terminal', name: '手持检票POS', nameEn: 'IconPosTerminal', category: 'devices', component: IconPosTerminal, tags: ['手持机', '验票机', 'POS', '移动终端'] },
  { id: 'power-station', name: '变电所UPS', nameEn: 'IconUpsPower', category: 'devices', component: IconUpsPower, tags: ['UPS', '供电', '后备电源', '配电箱'] },
  { id: 'network-switch', name: '工业交换机', nameEn: 'IconIndustrialSwitch', category: 'devices', component: IconIndustrialSwitch, tags: ['网络', '交换机', '光纤', '通信'] },
  { id: 'station-topology', name: '车站拓扑网', nameEn: 'IconStationNetwork', category: 'devices', component: IconStationNetwork, tags: ['拓扑', '站点', '线路', '路网'] },

  // --- 常用运维、工器具与状态 ---
  { id: 'wrench', name: '维修扳手', nameEn: 'Wrench', category: 'ops', component: Wrench, tags: ['维修', '检修', '工具', '消缺'] },
  { id: 'toolbox', name: '工器具箱', nameEn: 'Toolbox', category: 'ops', component: Toolbox, tags: ['工具箱', '仪表', '工器具'] },
  { id: 'shield-check', name: '安全防护', nameEn: 'ShieldCheck', category: 'ops', component: ShieldCheck, tags: ['安全', '防护', '盾牌', '合规'] },
  { id: 'robot', name: '智能机器人', nameEn: 'Robot', category: 'ops', component: Robot, tags: ['智能', '自动化', '巡检'] },
  { id: 'brain', name: 'AI算法诊断', nameEn: 'Brain', category: 'ops', component: Brain, tags: ['大脑', '算法', '智能诊断'] },
  { id: 'sparkle', name: '智能助手', nameEn: 'Sparkle', category: 'ops', component: Sparkle, tags: ['闪耀', 'AI', '助手'] },
  { id: 'map-pin', name: '车站定位', nameEn: 'MapPin', category: 'ops', component: MapPin, tags: ['地点', '车站', '位置'] },
  { id: 'camera', name: '拍照取证', nameEn: 'Camera', category: 'ops', component: Camera, tags: ['相机', '拍照', '现场照片'] },
  { id: 'image', name: '图片附件', nameEn: 'Image', category: 'ops', component: Image, tags: ['图片', '附件', '相册'] },
  { id: 'qr-code', name: '二维码', nameEn: 'QrCode', category: 'ops', component: QrCode, tags: ['二维码', '扫码', '设备码'] },
  { id: 'printer', name: '报表打印', nameEn: 'Printer', category: 'ops', component: Printer, tags: ['打印', '导出', '纸质报表'] },
  { id: 'download-simple', name: '数据下载', nameEn: 'DownloadSimple', category: 'ops', component: DownloadSimple, tags: ['下载', '导出', '报表'] },
  { id: 'upload-simple', name: '数据上传', nameEn: 'UploadSimple', category: 'ops', component: UploadSimple, tags: ['上传', '导入', '附件'] },
  { id: 'bell-ringing', name: '消息提醒', nameEn: 'BellRinging', category: 'ops', component: BellRinging, tags: ['铃铛', '提醒', '通知', '预警'] },
  { id: 'database', name: '数据底座', nameEn: 'Database', category: 'ops', component: Database, tags: ['数据库', '台账', '存储'] },
  { id: 'file-text', name: '文档档案', nameEn: 'FileText', category: 'ops', component: FileText, tags: ['文件', '文档', 'txt', '日志'] },
  { id: 'file-pdf', name: 'PDF文档', nameEn: 'FilePdf', category: 'ops', component: FilePdf, tags: ['PDF', '规程', '标准'] },
  { id: 'file-zip', name: '压缩包', nameEn: 'FileZip', category: 'ops', component: FileZip, tags: ['ZIP', '打包', '附件'] },

  // --- 系统控制与基础控件 ---
  { id: 'magnifying-glass', name: '搜索查询', nameEn: 'MagnifyingGlass', category: 'system', component: MagnifyingGlass, tags: ['搜索', '查找', '放大镜'] },
  { id: 'funnel', name: '条件筛选', nameEn: 'Funnel', category: 'system', component: Funnel, tags: ['筛选', '漏斗', '过滤'] },
  { id: 'sliders-horizontal', name: '高级配置', nameEn: 'SlidersHorizontal', category: 'system', component: SlidersHorizontal, tags: ['滑块', '配置', '参数'] },
  { id: 'arrows-clockwise', name: '刷新同步', nameEn: 'ArrowsClockwise', category: 'system', component: ArrowsClockwise, tags: ['刷新', '同步', '重载'] },
  { id: 'eye', name: '查看明细', nameEn: 'Eye', category: 'system', component: Eye, tags: ['查看', '显示', '明文'] },
  { id: 'eye-slash', name: '隐藏密文', nameEn: 'EyeSlash', category: 'system', component: EyeSlash, tags: ['隐藏', '掩码', '密码'] },
  { id: 'lock', name: '权限锁定', nameEn: 'Lock', category: 'system', component: Lock, tags: ['锁', '权限', '安全'] },
  { id: 'lock-key-open', name: '解锁授权', nameEn: 'LockKeyOpen', category: 'system', component: LockKeyOpen, tags: ['开锁', '授权', '放行'] },
  { id: 'pencil-simple', name: '编辑修改', nameEn: 'PencilSimple', category: 'system', component: PencilSimple, tags: ['编辑', '修改', '铅笔'] },
  { id: 'trash', name: '删除清理', nameEn: 'Trash', category: 'system', component: Trash, tags: ['删除', '垃圾桶', '清空'] },
  { id: 'plus', name: '新建添加', nameEn: 'Plus', category: 'system', component: Plus, tags: ['添加', '加号', '新建'] },
  { id: 'check', name: '确认选中', nameEn: 'Check', category: 'system', component: Check, tags: ['对勾', '确认', '成功'] },
  { id: 'check-circle', name: '校验通过', nameEn: 'CheckCircle', category: 'system', component: CheckCircle, tags: ['通过', '完成', '圆圈'] },
  { id: 'x-icon', name: '关闭取消', nameEn: 'X', category: 'system', component: X, tags: ['叉', '关闭', '取消', '退出'] },
  { id: 'clock', name: '时间记录', nameEn: 'Clock', category: 'system', component: Clock, tags: ['时钟', '时间', '打卡'] },
  { id: 'clock-counter-clockwise', name: '变更历史', nameEn: 'ClockCounterClockwise', category: 'system', component: ClockCounterClockwise, tags: ['历史', '回溯', '追溯'] },
  { id: 'buildings', name: '车站楼宇', nameEn: 'Buildings', category: 'system', component: Buildings, tags: ['大楼', '站点', '基地'] },
  { id: 'phone', name: '电话热线', nameEn: 'Phone', category: 'system', component: Phone, tags: ['电话', '热线', '呼叫'] },
  { id: 'headset', name: '客服调度', nameEn: 'Headset', category: 'system', component: Headset, tags: ['调度', '客服', '耳机'] }
];
