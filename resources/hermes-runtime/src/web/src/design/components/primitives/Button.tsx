// Button — KnockDesk v2 primitive (createElement style: no JSX fragment issues).
import React, { forwardRef, useEffect } from 'react';
import type { ButtonHTMLAttributes } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg' | 'icon';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  // Backward compat with @nous-research/ui Button API
  ghost?: boolean;
}

const baseStyles: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 'var(--kd-space-2)',
  fontFamily: 'var(--kd-font-family-sans)',
  fontWeight: 'var(--kd-font-weight-medium)',
  borderRadius: 'var(--kd-radius-md)',
  border: 'none',
  cursor: 'pointer',
  transition: 'all var(--kd-motion-fast)',
  whiteSpace: 'nowrap',
  textDecoration: 'none',
  outline: 'none',
  position: 'relative',
};

const variantStyles: Record<NonNullable<ButtonProps['variant']>, React.CSSProperties> = {
  primary: {
    background: 'var(--kd-color-accent-cyan)',
    color: 'var(--kd-color-bg-primary)',
    boxShadow: 'var(--kd-shadow-sm)',
  },
  secondary: {
    background: 'var(--kd-color-bg-secondary)',
    color: 'var(--kd-color-fg-primary)',
    border: '1px solid var(--kd-color-border-default)',
    boxShadow: 'var(--kd-shadow-sm)',
  },
  ghost: {
    background: 'transparent',
    color: 'var(--kd-color-fg-primary)',
  },
  danger: {
    background: 'var(--kd-color-accent-rose)',
    color: 'var(--kd-color-bg-primary)',
    boxShadow: 'var(--kd-shadow-sm)',
  },
  success: {
    background: 'var(--kd-color-accent-emerald)',
    color: 'var(--kd-color-bg-primary)',
    boxShadow: 'var(--kd-shadow-sm)',
  },
};

const sizeStyles: Record<NonNullable<ButtonProps['size']>, React.CSSProperties> = {
  xs: { padding: 'var(--kd-space-1) var(--kd-space-2)', fontSize: 'var(--kd-font-size-xs)', minHeight: '24px' },
  sm: { padding: 'var(--kd-space-1) var(--kd-space-3)', fontSize: 'var(--kd-font-size-sm)', minHeight: '32px' },
  md: { padding: 'var(--kd-space-2) var(--kd-space-4)', fontSize: 'var(--kd-font-size-base)', minHeight: '40px' },
  lg: { padding: 'var(--kd-space-3) var(--kd-space-5)', fontSize: 'var(--kd-font-size-lg)', minHeight: '48px' },
  icon: { padding: 'var(--kd-space-2)', fontSize: 'var(--kd-font-size-base)', minHeight: '40px', width: '40px' },
};

function LoadingSpinner() {
  return React.createElement(
    React.Fragment,
    null,
    React.createElement('span', {
      style: {
        width: '16px', height: '16px',
        border: '2px solid currentColor',
        borderRightColor: 'transparent',
        borderRadius: '50%',
        animation: 'kd-spin 0.8s linear infinite',
      },
    }),
    React.createElement('span', null, 'Loading…'),
  );
}

function ButtonContent({
  leftIcon,
  rightIcon,
  children,
}: {
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return React.createElement(
    React.Fragment,
    null,
    leftIcon ? React.createElement('span', { style: { display: 'flex' } }, leftIcon) : null,
    React.createElement('span', null, children),
    rightIcon ? React.createElement('span', { style: { display: 'flex' } }, rightIcon) : null,
  );
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'primary',
    size = 'md',
    loading = false,
    fullWidth = false,
    leftIcon,
    rightIcon,
    disabled,
    children,
    style,
    className,
    onClick,
    ghost,
    ...props
  },
  ref,
) {
  const isDisabled = disabled || loading;

  // Backward compat: ghost={true} => variant="ghost"
  const effectiveVariant = ghost === true ? 'ghost' : variant;

  const handleClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (isDisabled) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    onClick?.(e);
  };

  const combinedStyle: React.CSSProperties = {
    ...baseStyles,
    ...variantStyles[effectiveVariant],
    ...sizeStyles[size],
    width: fullWidth ? '100%' : undefined,
    opacity: isDisabled ? 0.5 : 1,
    pointerEvents: isDisabled ? 'none' : 'auto',
    ...style,
  };

  useEffect(() => {
    if (typeof document !== 'undefined' && !document.getElementById('kd-button-styles')) {
      const el = document.createElement('style');
      el.id = 'kd-button-styles';
      el.textContent = '@keyframes kd-spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(el);
    }
  }, []);

  const body = loading
    ? React.createElement(LoadingSpinner, null)
    : React.createElement(ButtonContent, { leftIcon, rightIcon, children }, null);

  return React.createElement(
    'button',
    {
      ref,
      disabled: isDisabled,
      onClick: handleClick,
      style: combinedStyle,
      className,
      'aria-busy': loading,
      'aria-disabled': isDisabled,
      ...props,
    },
    body,
  );
});

export default Button;