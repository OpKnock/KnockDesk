// Spinner — KnockDesk v2 primitive
import React, { useEffect } from 'react';

interface SpinnerProps {
  className?: string;
  size?: 'sm' | 'md' | 'lg';
  'aria-label'?: string;
}

const sizeStyles: Record<NonNullable<SpinnerProps['size']>, React.CSSProperties> = {
  sm: { width: '14px', height: '14px', borderWidth: '2px' },
  md: { width: '20px', height: '20px', borderWidth: '2px' },
  lg: { width: '28px', height: '28px', borderWidth: '3px' },
};

export function Spinner({ className = '', size = 'md', 'aria-label': ariaLabel = 'Loading' }: SpinnerProps) {
  useEffect(() => {
    if (typeof document !== 'undefined' && !document.getElementById('kd-spinner-styles')) {
      const el = document.createElement('style');
      el.id = 'kd-spinner-styles';
      el.textContent = '@keyframes kd-spin { to { transform: rotate(360deg); } }';
      document.head.appendChild(el);
    }
  }, []);

  return React.createElement(
    'span',
    {
      className: `inline-block ${className}`,
      role: 'status',
      'aria-label': ariaLabel,
      style: {
        ...sizeStyles[size],
        border: '2px solid currentColor',
        borderRightColor: 'transparent',
        borderRadius: '50%',
        animation: 'kd-spin 0.8s linear infinite',
        display: 'inline-block',
        verticalAlign: 'middle',
      },
    },
    React.createElement('span', { className: 'sr-only' }, 'Loading…'),
  );
}

export default Spinner;