import {
  Baby,
  Bell,
  Calendar,
  ChartColumn,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  CircleAlert,
  Clock,
  Droplet,
  Droplets,
  Ellipsis,
  HeartPulse,
  Inbox,
  Info,
  Milk,
  Moon,
  Pencil,
  Pill,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Soup,
  Sun,
  Thermometer,
  TrendingUp,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react';

/**
 * Único juego de iconos de la app (Lucide, trazo 1,75). Nada de caracteres Unicode ni emoji como icono:
 * cambian con la fuente del sistema y rompen la paleta, sobre todo en modo noche.
 * Ver docs/design/BABYSLEEP_DESIGN_SYSTEM.md §2.4.
 */
const ICONS = {
  baby: Baby,
  bell: Bell,
  calendar: Calendar,
  chart: ChartColumn,
  check: Check,
  down: ChevronDown,
  next: ChevronRight,
  swap: ChevronsUpDown,
  alert: CircleAlert,
  clock: Clock,
  drop: Droplet,
  drops: Droplets,
  more: Ellipsis,
  health: HeartPulse,
  empty: Inbox,
  info: Info,
  milk: Milk,
  moon: Moon,
  pencil: Pencil,
  pill: Pill,
  undo: RotateCcw,
  vaccine: ShieldCheck,
  settings: SlidersHorizontal,
  solids: Soup,
  sun: Sun,
  thermo: Thermometer,
  growth: TrendingUp,
  user: UserRound,
  close: X,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/** Decorativo por defecto (`aria-hidden`): el texto de al lado da el nombre. Con `label` pasa a ser `role="img"`. */
export function Icon({ name, size = 20, className = '', label }: { name: IconName; size?: number; className?: string; label?: string }) {
  const C = ICONS[name];
  return label ? (
    <C size={size} strokeWidth={1.75} className={`shrink-0 ${className}`} role="img" aria-label={label} />
  ) : (
    <C size={size} strokeWidth={1.75} className={`shrink-0 ${className}`} aria-hidden />
  );
}
