import { createTheme, type MantineColorsTuple } from '@mantine/core';

const fontStack = [
  'system-ui',
  '-apple-system',
  '"Segoe UI"',
  'Roboto',
  'Helvetica',
  'Arial',
  'sans-serif',
  '"Apple Color Emoji"',
  '"Segoe UI Emoji"',
].join(', ');

const monospaceStack = [
  'ui-monospace',
  'SFMono-Regular',
  '"SF Mono"',
  'Menlo',
  'Consolas',
  '"Liberation Mono"',
  'monospace',
].join(', ');

/**
 * TopSkip brand teal — a clean, modern teal that conveys reliability and
 * tech-savviness without being Mantine's default blue.
 *
 * Shade 6 is the primary filled-background color in light mode.
 */
const brand: MantineColorsTuple = [
  '#e6fcf5',
  '#c3fae8',
  '#96f2d7',
  '#63e6be',
  '#38d9a9',
  '#20c997',
  '#12b886',
  '#0ca678',
  '#099268',
  '#087f5b',
];

/**
 * Success green (distinct from brand teal for semantic clarity).
 */
const success: MantineColorsTuple = [
  '#ebfbee',
  '#d3f9d8',
  '#b2f2bb',
  '#8ce99a',
  '#69db7c',
  '#51cf66',
  '#40c057',
  '#37b24d',
  '#2f9e44',
  '#2b8a3e',
];

/**
 * Warning amber.
 */
const warning: MantineColorsTuple = [
  '#fff9db',
  '#fff3bf',
  '#ffec99',
  '#ffe066',
  '#ffd43b',
  '#fcc419',
  '#fab005',
  '#f59f00',
  '#f08c00',
  '#e67700',
];

/**
 * Error red.
 */
const error: MantineColorsTuple = [
  '#fff5f5',
  '#ffe3e3',
  '#ffc9c9',
  '#ffa8a8',
  '#ff8787',
  '#ff6b6b',
  '#fa5252',
  '#f03e3e',
  '#e03131',
  '#c92a2a',
];

/**
 * Quiet neutral slate for surfaces and calm information framing.
 */
const slate: MantineColorsTuple = [
  '#f8fafc',
  '#f1f5f9',
  '#e2e8f0',
  '#cbd5e1',
  '#94a3b8',
  '#64748b',
  '#475569',
  '#334155',
  '#1e293b',
  '#0f172a',
];

/**
 * Shared Mantine theme for popup and options entry points.
 *
 * This is the single source of truth for the TopSkip design system.
 * All color, typography, spacing, radius, and component defaults live here.
 */
export const topskipTheme = createTheme({
  primaryColor: 'brand',
  primaryShade: { light: 6, dark: 5 },
  colors: {
    brand,
    success,
    warning,
    error,
    slate,
  },

  autoContrast: true,
  luminanceThreshold: 0.3,

  fontFamily: fontStack,
  fontFamilyMonospace: monospaceStack,

  headings: {
    fontFamily: fontStack,
    fontWeight: '700',
    sizes: {
      h1: { fontSize: '2rem', lineHeight: '1.1' },
      h2: { fontSize: '1.5rem', lineHeight: '1.15' },
      h3: { fontSize: '1.25rem', lineHeight: '1.2' },
      h4: { fontSize: '1.0625rem', lineHeight: '1.25' },
      h5: { fontSize: '0.9375rem', lineHeight: '1.3' },
      h6: { fontSize: '0.8125rem', lineHeight: '1.35' },
    },
  },

  fontSizes: {
    xs: '0.6875rem',
    sm: '0.8125rem',
    md: '0.9375rem',
    lg: '1.0625rem',
    xl: '1.25rem',
  },

  lineHeights: {
    xs: '1.35',
    sm: '1.4',
    md: '1.5',
    lg: '1.55',
    xl: '1.6',
  },

  spacing: {
    xs: '0.375rem',
    sm: '0.625rem',
    md: '1rem',
    lg: '1.25rem',
    xl: '1.75rem',
  },

  radius: {
    xs: '0.125rem',
    sm: '0.25rem',
    md: '0.5rem',
    lg: '0.75rem',
    xl: '1rem',
  },
  defaultRadius: 'md',

  shadows: {
    xs: '0 1px 2px rgba(15, 23, 42, 0.06)',
    sm: '0 8px 20px rgba(15, 23, 42, 0.08)',
    md: '0 14px 30px rgba(15, 23, 42, 0.12)',
  },

  respectReducedMotion: true,

  components: {
    Button: {
      defaultProps: {
        radius: 'md',
        fw: 600,
      },
    },
    TextInput: {
      defaultProps: {
        radius: 'md',
        size: 'sm',
      },
    },
    Select: {
      defaultProps: {
        radius: 'md',
        size: 'sm',
      },
    },
    Switch: {
      defaultProps: {
        radius: 'xl',
      },
    },
    Checkbox: {
      defaultProps: {
        radius: 'sm',
      },
    },
    Alert: {
      defaultProps: {
        radius: 'md',
        variant: 'light',
        withCloseButton: false,
      },
    },
    Text: {
      defaultProps: {
        size: 'sm',
      },
    },
    Paper: {
      defaultProps: {
        radius: 'lg',
        withBorder: true,
        shadow: 'xs',
      },
    },
    Badge: {
      defaultProps: {
        radius: 'xl',
        variant: 'light',
      },
    },
    Stack: {
      defaultProps: {
        gap: 'md',
      },
    },
  },
});
