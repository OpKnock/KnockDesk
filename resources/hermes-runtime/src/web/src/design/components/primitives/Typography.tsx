// Typography — KnockDesk v2 primitive
import React from 'react';

export interface TypographyProps extends React.HTMLAttributes<HTMLElement> {
  variant?: 'h1' | 'h2' | 'h3' | 'h4' | 'body' | 'body-sm' | 'caption' | 'code' | 'blockquote';
  component?: React.ElementType;
  children: React.ReactNode;
}

const variantStyles: Record<NonNullable<TypographyProps['variant']>, React.CSSProperties> = {
  h1: { fontSize: 'var(--kd-font-size-3xl)', fontWeight: 'var(--kd-font-weight-bold)', lineHeight: 'var(--kd-line-height-tight)', letterSpacing: 'var(--kd-letter-spacing-tight)' },
  h2: { fontSize: 'var(--kd-font-size-2xl)', fontWeight: 'var(--kd-font-weight-semibold)', lineHeight: 'var(--kd-line-height-tight)', letterSpacing: 'var(--kd-letter-spacing-tight)' },
  h3: { fontSize: 'var(--kd-font-size-xl)', fontWeight: 'var(--kd-font-weight-semibold)', lineHeight: 'var(--kd-line-height-snug)' },
  h4: { fontSize: 'var(--kd-font-size-lg)', fontWeight: 'var(--kd-font-weight-medium)', lineHeight: 'var(--kd-line-height-snug)' },
  body: { fontSize: 'var(--kd-font-size-base)', fontWeight: 'var(--kd-font-weight-normal)', lineHeight: 'var(--kd-line-height-normal)' },
  'body-sm': { fontSize: 'var(--kd-font-size-sm)', fontWeight: 'var(--kd-font-weight-normal)', lineHeight: 'var(--kd-line-height-normal)' },
  caption: { fontSize: 'var(--kd-font-size-xs)', fontWeight: 'var(--kd-font-weight-normal)', lineHeight: 'var(--kd-line-height-normal)', color: 'var(--kd-color-fg-muted)' },
  code: { fontSize: 'var(--kd-font-size-sm)', fontWeight: 'var(--kd-font-weight-normal)', fontFamily: 'var(--kd-font-family-mono)', background: 'var(--kd-color-bg-tertiary)', padding: 'var(--kd-space-1) var(--kd-space-2)', borderRadius: 'var(--kd-radius-sm)' },
  blockquote: { fontSize: 'var(--kd-font-size-base)', fontWeight: 'var(--kd-font-weight-normal)', lineHeight: 'var(--kd-line-height-normal)', borderLeft: '3px solid var(--kd-color-accent-cyan)', paddingLeft: 'var(--kd-space-4)', marginLeft: 'var(--kd-space-4)', color: 'var(--kd-color-fg-secondary)', fontStyle: 'italic' },
};

const defaultComponents: Record<NonNullable<TypographyProps['variant']>, React.ElementType> = {
  h1: 'h1',
  h2: 'h2',
  h3: 'h3',
  h4: 'h4',
  body: 'p',
  'body-sm': 'p',
  caption: 'span',
  code: 'code',
  blockquote: 'blockquote',
};

export function Typography({
  variant = 'body',
  component,
  children,
  style,
  className,
  ...props
}: TypographyProps) {
  const Component = component ?? defaultComponents[variant];
  return React.createElement(
    Component,
    {
      ...props,
      style: { ...variantStyles[variant], ...style },
      className,
    },
    children,
  );
}

export default Typography;