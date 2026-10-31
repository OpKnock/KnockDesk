// KnockDesk v2 Design Tokens
// Single source of truth for all visual decisions
// Replaces: themes/presets.ts, themes/types.ts, themes/fonts.ts

export const tokens = {
  // ─── Color Primitives ───
  color: {
    // Base backgrounds
    bg: {
      primary:     '#0a0c10',  // Main canvas
      secondary:   '#111318',  // Cards, panels
      tertiary:    '#181b22',  // Elevated, modals
      inverse:     '#f0f2f5',  // On dark accents
      hover:       '#1a1e26',  // Interactive hover
      active:      '#222730',  // Interactive active
    },

    // Foregrounds (text, icons)
    fg: {
      primary:     '#e8eaed',  // Primary text
      secondary:   '#9aa0a6',  // Secondary text
      muted:       '#6b7280',  // Placeholder, disabled
      inverse:     '#1a1a2e',  // On light backgrounds
      link:        '#4fc3f7',  // Links
    },

    // Borders
    border: {
      default:     '#252933',
      strong:      '#313642',
      focus:       '#4fc3f7',
      error:       '#f44336',
      success:     '#4caf50',
    },

    // Brand accents (semantic, not decorative)
    accent: {
      cyan:        '#4fc3f7',  // Primary brand
      amber:       '#ffb300',  // Warning/attention
      emerald:     '#4ade80',  // Success/running
      rose:        '#f87171',  // Error/danger
      violet:      '#c084fc',  // AI/magic features
      indigo:      '#818cf8',  // Secondary actions
    },

    // Status semantics
    status: {
      info:        '#4fc3f7',
      success:     '#4ade80',
      warning:     '#ffb300',
      error:       '#f87171',
    },

    // Overlay layers
    overlay: {
      scrim:       'rgba(0,0,0,0.6)',
      modal:       'rgba(10,12,16,0.95)',
      popover:     'rgba(17,19,24,0.98)',
      tooltip:     'rgba(26,29,36,0.95)',
    },
  },

  // ─── Spacing Scale (4px base) ───
  space: {
    0:   '0',
    1:   '4px',
    2:   '8px',
    3:   '12px',
    4:   '16px',
    5:   '20px',
    6:   '24px',
    8:   '32px',
    10:  '40px',
    12:  '48px',
    16:  '64px',
    20:  '80px',
    24:  '96px',
  },

  // ─── Border Radius ───
  radius: {
    none:  '0',
    sm:    '4px',
    md:    '8px',
    lg:    '12px',
    xl:    '16px',
    '2xl': '24px',
    full:  '9999px',
  },

  // ─── Shadows ───
  shadow: {
    sm:    '0 1px 2px rgba(0,0,0,0.3)',
    md:    '0 4px 12px rgba(0,0,0,0.4)',
    lg:    '0 12px 28px rgba(0,0,0,0.5)',
    xl:    '0 20px 40px rgba(0,0,0,0.6)',
    focus: '0 0 0 3px rgba(79,195,247,0.4)',
    inner: 'inset 0 2px 4px rgba(0,0,0,0.3)',
  },

  // ─── Typography ───
  font: {
    family: {
      sans:    '"Inter", "IBM Plex Sans", system-ui, sans-serif',
      mono:    '"JetBrains Mono", "Fira Code", monospace',
      ui:      'system-ui, -apple-system, sans-serif',
    },
    size: {
      xs:   '11px',
      sm:   '13px',
      base: '14px',
      lg:   '16px',
      xl:   '18px',
      '2xl': '20px',
      '3xl': '24px',
      '4xl': '30px',
    },
    weight: {
      normal:    400,
      medium:    500,
      semibold:  600,
      bold:      700,
    },
    lineHeight: {
      tight:     1.2,
      normal:    1.5,
      relaxed:   1.75,
      code:      1.6,
    },
  },

  // ─── Motion ───
  motion: {
    fast:   '120ms cubic-bezier(0.2, 0.8, 0.2, 1)',
    normal: '200ms cubic-bezier(0.2, 0.8, 0.2, 1)',
    slow:   '300ms cubic-bezier(0.2, 0.8, 0.2, 1)',
    spring: '400ms cubic-bezier(0.34, 1.56, 0.64, 1)',
  },

  // ─── Z-Index ───
  zIndex: {
    base:      0,
    dropdown:  100,
    sticky:    200,
    modal:     300,
    popover:   400,
    tooltip:   500,
    toast:     600,
    command:   700,
  },

  // ─── Breakpoints ───
  breakpoint: {
    sm:  '640px',
    md:  '768px',
    lg:  '1024px',
    xl:  '1280px',
    '2xl': '1536px',
  },
} as const;

// ============================================================================
// Semantic Aliases Export
// Provides the same interface as the original semantic object but with CSS variables
// ============================================================================
export const semantic = {
  // Color Primitives
  color: {
    bg: {
      primary:     'var(--kd-color-bg-primary)',
      secondary:   'var(--kd-color-bg-secondary)',
      tertiary:    'var(--kd-color-bg-tertiary)',
      inverse:     'var(--kd-color-bg-inverse)',
      hover:       'var(--kd-color-bg-hover)',
      active:      'var(--kd-color-bg-active)',
    },
    fg: {
      primary:     'var(--kd-color-fg-primary)',
      secondary:   'var(--kd-color-fg-secondary)',
      muted:       'var(--kd-color-fg-muted)',
      inverse:     'var(--kd-color-fg-inverse)',
      link:        'var(--kd-color-fg-link)',
    },
    border: {
      default:     'var(--kd-color-border-default)',
      strong:      'var(--kd-color-border-strong)',
      focus:       'var(--kd-color-border-focus)',
      error:       'var(--kd-color-border-error)',
      success:     'var(--kd-color-border-success)',
    },
    accent: {
      cyan:        'var(--kd-color-accent-cyan)',
      amber:       'var(--kd-color-accent-amber)',
      emerald:     'var(--kd-color-accent-emerald)',
      rose:        'var(--kd-color-accent-rose)',
      violet:      'var(--kd-color-accent-violet)',
      indigo:      'var(--kd-color-accent-indigo)',
    },
    status: {
      info:        'var(--kd-color-status-info)',
      success:     'var(--kd-color-status-success)',
      warning:     'var(--kd-color-status-warning)',
      error:       'var(--kd-color-status-error)',
    },
    overlay: {
      scrim:       'var(--kd-color-overlay-scrim)',
      modal:       'var(--kd-color-overlay-modal)',
      popover:     'var(--kd-color-overlay-popover)',
      tooltip:     'var(--kd-color-overlay-tooltip)',
    },
  },

  // Spacing Scale (4px base)
  space: {
    0:   'var(--kd-space-0)',
    1:   'var(--kd-space-1)',
    2:   'var(--kd-space-2)',
    3:   'var(--kd-space-3)',
    4:   'var(--kd-space-4)',
    5:   'var(--kd-space-5)',
    6:   'var(--kd-space-6)',
    8:   'var(--kd-space-8)',
    10:  'var(--kd-space-10)',
    12:  'var(--kd-space-12)',
    16:  'var(--kd-space-16)',
    20:  'var(--kd-space-20)',
    24:  'var(--kd-space-24)',
  },

  // Border Radius
  radius: {
    none:  'var(--kd-radius-none)',
    sm:    'var(--kd-radius-sm)',
    md:    'var(--kd-radius-md)',
    lg:    'var(--kd-radius-lg)',
    xl:    'var(--kd-radius-xl)',
    '2xl': 'var(--kd-radius-2xl)',
    full:  'var(--kd-radius-full)',
  },

  // Shadows
  shadow: {
    sm:    'var(--kd-shadow-sm)',
    md:    'var(--kd-shadow-md)',
    lg:    'var(--kd-shadow-lg)',
    xl:    'var(--kd-shadow-xl)',
    focus: 'var(--kd-shadow-focus)',
    inner: 'var(--kd-shadow-inner)',
  },

  // Typography
  font: {
    family: {
      sans:    'var(--kd-font-family-sans)',
      mono:    'var(--kd-font-family-mono)',
      ui:      'var(--kd-font-family-ui)',
    },
    size: {
      xs:   'var(--kd-font-size-xs)',
      sm:   'var(--kd-font-size-sm)',
      base: 'var(--kd-font-size-base)',
      lg:   'var(--kd-font-size-lg)',
      xl:   'var(--kd-font-size-xl)',
      '2xl': 'var(--kd-font-size-2xl)',
      '3xl': 'var(--kd-font-size-3xl)',
      '4xl': 'var(--kd-font-size-4xl)',
    },
    weight: {
      normal:    'var(--kd-font-weight-normal)',
      medium:    'var(--kd-font-weight-medium)',
      semibold:  'var(--kd-font-weight-semibold)',
      bold:      'var(--kd-font-weight-bold)',
    },
    lineHeight: {
      tight:     'var(--kd-font-line-height-tight)',
      normal:    'var(--kd-font-line-height-normal)',
      relaxed:   'var(--kd-font-line-height-relaxed)',
      code:      'var(--kd-font-line-height-code)',
    },
  },

  // Motion
  motion: {
    fast:   'var(--kd-motion-fast)',
    normal: 'var(--kd-motion-normal)',
    slow:   'var(--kd-motion-slow)',
    spring: 'var(--kd-motion-spring)',
  },

  // Z-Index
  zIndex: {
    base:      'var(--kd-zIndex-base)',
    dropdown:  'var(--kd-zIndex-dropdown)',
    sticky:    'var(--kd-zIndex-sticky)',
    modal:     'var(--kd-zIndex-modal)',
    popover:   'var(--kd-zIndex-popover)',
    tooltip:   'var(--kd-zIndex-tooltip)',
    toast:     'var(--kd-zIndex-toast)',
    command:   'var(--kd-zIndex-command)',
  },

  // Breakpoints
  breakpoint: {
    sm:  'var(--kd-breakpoint-sm)',
    md:  'var(--kd-breakpoint-md)',
    lg:  'var(--kd-breakpoint-lg)',
    xl:  'var(--kd-breakpoint-xl)',
    '2xl': 'var(--kd-breakpoint-2xl)',
  },

  // Semantic Aliases (for component usage)
  bgCanvas:      'var(--kd-bgCanvas)',
  bgCard:        'var(--kd-bgCard)',
  bgElevated:    'var(--kd-bgElevated)',
  bgHover:       'var(--kd-bgHover)',
  bgActive:      'var(--kd-bgActive)',

  textPrimary:   'var(--kd-textPrimary)',
  textSecondary: 'var(--kd-textSecondary)',
  textMuted:     'var(--kd-textMuted)',
  textLink:      'var(--kd-textLink)',

  borderDefault: 'var(--kd-borderDefault)',
  borderStrong:  'var(--kd-borderStrong)',
  borderFocus:   'var(--kd-borderFocus)',

  brandPrimary:  'var(--kd-brandPrimary)',
  brandWarning:  'var(--kd-brandWarning)',
  brandSuccess:  'var(--kd-brandSuccess)',
  brandError:    'var(--kd-brandError)',
  brandMagic:    'var(--kd-brandMagic)',

  statusInfo:    'var(--kd-statusInfo)',
  statusOk:      'var(--kd-statusOk)',
  statusWarn:    'var(--kd-statusWarn)',
  statusErr:     'var(--kd-statusErr)',

  overlayScrim:  'var(--kd-overlayScrim)',
  overlayModal:  'var(--kd-overlayModal)',
  overlayPopover:'var(--kd-overlayPopover)',

  space1: 'var(--kd-space-1)',
  space2: 'var(--kd-space-2)',
  space3: 'var(--kd-space-3)',
  space4: 'var(--kd-space-4)',
  space5: 'var(--kd-space-5)',
  space6: 'var(--kd-space-6)',
  space8: 'var(--kd-space-8)',

  radiusSm: 'var(--kd-radius-sm)',
  radiusMd: 'var(--kd-radius-md)',
  radiusLg: 'var(--kd-radius-lg)',
  radiusXl: 'var(--kd-radius-xl)',
  radiusFull: 'var(--kd-radius-full)',

  shadowSm: 'var(--kd-shadow-sm)',
  shadowMd: 'var(--kd-shadow-md)',
  shadowLg: 'var(--kd-shadow-lg)',
  shadowFocus: 'var(--kd-shadow-focus)',

  fontSans: 'var(--kd-fontSans)',
  fontMono: 'var(--kd-fontMono)',
  textXs: 'var(--kd-textXs)',
  textSm: 'var(--kd-textSm)',
  textBase: 'var(--kd-textBase)',
  textLg: 'var(--kd-textLg)',
  textXl: 'var(--kd-textXl)',
  fontNormal: 'var(--kd-fontNormal)',
  fontMedium: 'var(--kd-fontMedium)',
  fontSemibold: 'var(--kd-fontSemibold)',
  fontBold: 'var(--kd-fontBold)',

  motionFast: 'var(--kd-motionFast)',
  motionNormal: 'var(--kd-motionNormal)',
  motionSlow: 'var(--kd-motionSlow)',

  zModal: 'var(--kd-zModal)',
  zPopover: 'var(--kd-zPopover)',
  zToast: 'var(--kd-zToast)',
} as const;