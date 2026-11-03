/**
 * 全局设计 Token —— v2
 */

export class Color {
  static readonly primary: string = '#0EA5E9';
  static readonly primaryDark: string = '#0284C7';
  static readonly primaryLight: string = '#E0F2FE';
  static readonly accent: string = '#F97316';
  static readonly accentDark: string = '#EA580C';

  static readonly success: string = '#10B981';
  static readonly successDark: string = '#059669';
  static readonly successLight: string = '#D1FAE5';
  static readonly warning: string = '#F59E0B';
  static readonly warningDark: string = '#D97706';
  static readonly warningLight: string = '#FEF3C7';
  static readonly critical: string = '#EF4444';
  static readonly criticalDark: string = '#DC2626';
  static readonly criticalLight: string = '#FEE2E2';
  static readonly info: string = '#0EA5E9';

  static readonly bg: string = '#F6F9FC';
  static readonly card: string = '#FFFFFF';
  static readonly border: string = '#E6EDF5';
  static readonly track: string = '#EDF2F8';
  static readonly textPrimary: string = '#0F172A';
  static readonly textSecondary: string = '#64748B';
  static readonly textTertiary: string = '#94A3B8';
}

export class Space {
  static readonly xs: number = 4;
  static readonly sm: number = 8;
  static readonly md: number = 12;
  static readonly lg: number = 16;
  static readonly xl: number = 20;
  static readonly xxl: number = 24;
  static readonly xxxl: number = 32;
}

export class Radius {
  static readonly card: number = 20;
  static readonly tile: number = 18;
  static readonly button: number = 14;
  static readonly chip: number = 12;
  static readonly pill: number = 999;
  static readonly image: number = 8;
}

export class FontSize {
  static readonly display: number = 32;
  static readonly h1: number = 21;
  static readonly h2: number = 17;
  static readonly h3: number = 14;
  static readonly body: number = 12;
  static readonly caption: number = 10.5;
  static readonly mini: number = 9.5;
}

export class FontWeight_ {
  static readonly extrabold: number = 800;
  static readonly bold: number = 700;
  static readonly semibold: number = 600;
  static readonly medium: number = 500;
  static readonly regular: number = 400;
}

export class Size {
  static readonly touchMin: number = 44;
  static readonly btnPrimary: number = 46;
  static readonly btnSecondary: number = 44;
  static readonly btnGhost: number = 40;
  static readonly medal: number = 42;
  static readonly medalSm: number = 32;
  static readonly iconSm: number = 16;
  static readonly iconMd: number = 20;
  static readonly iconLg: number = 24;
}

export class Grad {
  static primary(): LinearGradientOptions {
    return { angle: 135, colors: [['#38BDF8', 0.0], ['#0284C7', 1.0]] };
  }

  static critical(): LinearGradientOptions {
    return { angle: 135, colors: [['#F87171', 0.0], ['#DC2626', 1.0]] };
  }

  static warning(): LinearGradientOptions {
    return { angle: 135, colors: [['#FBBF24', 0.0], ['#D97706', 1.0]] };
  }

  static success(): LinearGradientOptions {
    return { angle: 135, colors: [['#34D399', 0.0], ['#059669', 1.0]] };
  }

  static accent(): LinearGradientOptions {
    return { angle: 135, colors: [['#FB923C', 0.0], ['#EA580C', 1.0]] };
  }

  static heroCritical(): LinearGradientOptions {
    return { angle: 140, colors: [['#FEE2E2', 0.0], ['#FFF5F5', 0.55], ['#FFFFFF', 1.0]] };
  }

  static heroWarning(): LinearGradientOptions {
    return { angle: 140, colors: [['#FEF3C7', 0.0], ['#FFFBEB', 0.55], ['#FFFFFF', 1.0]] };
  }

  static heroSuccess(): LinearGradientOptions {
    return { angle: 140, colors: [['#D1FAE5', 0.0], ['#F2FDF7', 0.55], ['#FFFFFF', 1.0]] };
  }

  static heroPrimary(): LinearGradientOptions {
    return { angle: 140, colors: [['#E0F2FE', 0.0], ['#F5FAFF', 0.6], ['#FFFFFF', 1.0]] };
  }

  static heroAccent(): LinearGradientOptions {
    return { angle: 140, colors: [['#FFF1E6', 0.0], ['#FFFBF7', 1.0]] };
  }

  static headWash(): LinearGradientOptions {
    return { angle: 180, colors: [['#E8F4FD', 0.0], ['#F6F9FC', 1.0]] };
  }

  static barPrimary(): LinearGradientOptions {
    return { angle: 180, colors: [['#7DD3FC', 0.0], ['#0284C7', 1.0]] };
  }

  static barWarning(): LinearGradientOptions {
    return { angle: 180, colors: [['#FCD34D', 0.0], ['#D97706', 1.0]] };
  }

  static barNight(): LinearGradientOptions {
    return { angle: 180, colors: [['#CBD5E1', 0.0], ['#94A3B8', 1.0]] };
  }

  static barEvening(): LinearGradientOptions {
    return { angle: 180, colors: [['#FDBA74', 0.0], ['#EA580C', 1.0]] };
  }

  static level(level: string): LinearGradientOptions {
    if (level === 'critical') return Grad.critical();
    if (level === 'high') return Grad.warning();
    if (level === 'medium') return Grad.primary();
    return { angle: 135, colors: [['#CBD5E1', 0.0], ['#94A3B8', 1.0]] };
  }
}

export class Shadow_ {
  static card(): ShadowOptions {
    return { radius: 12, color: 'rgba(15,23,42,0.06)', offsetX: 0, offsetY: 2 };
  }

  static pop(color: string): ShadowOptions {
    return { radius: 20, color: color, offsetX: 0, offsetY: 6 };
  }

  static medal(color: string): ShadowOptions {
    return { radius: 14, color: color, offsetX: 0, offsetY: 6 };
  }
}
