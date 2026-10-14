// SelectionSwitcher — KnockDesk component
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useProfileScope } from '@/contexts/useProfileScope';
import { Button } from '@/design/components/primitives/Button';
import { cn } from '@/lib/utils';
import { ChevronDown, Check } from 'lucide-react';

export function SelectionSwitcher() {
  const { profile, profiles, setProfile } = useProfileScope();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (buttonRef.current && !buttonRef.current.contains(e.target as Node)) {
        if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
          setOpen(false);
        }
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const currentProfile = profile || 'default';

  return (
    <div className="relative">
      <Button
        ref={buttonRef}
        variant="ghost"
        size="icon"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="text-text-secondary hover:text-midground"
      >
        <span className="hidden lg:inline-flex items-center gap-2">
          <span className="font-mono text-xs text-text-tertiary">{currentProfile}</span>
          <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
        </span>
        <span className="lg:hidden font-mono text-xs text-text-tertiary">{currentProfile}</span>
      </Button>

      {open && createPortal(
        <div
          ref={menuRef}
          className="fixed z-50 mt-1 min-w-[160px] bg-background-base border border-border-default rounded-lg shadow-lg py-1"
          style={{
            background: 'var(--kd-color-bg-secondary)',
            borderColor: 'var(--kd-color-border-default)',
          }}
          role="listbox"
          aria-label="Select profile"
        >
          {profiles.map((p) => (
            <button
              key={p}
              role="option"
              aria-selected={p === currentProfile}
              onClick={() => { setProfile(p); setOpen(false); }}
              className={cn(
                'w-full px-3 py-2 text-left text-sm font-mono transition-colors',
                'focus:outline-none focus:bg-bg-hover',
                p === currentProfile ? 'text-text-primary' : 'text-text-secondary hover:text-text-primary'
              )}
              style={{ background: p === currentProfile ? 'var(--kd-color-bg-hover)' : 'transparent' }}
            >
              <div className="flex items-center justify-between">
                <span>{p}</span>
                {p === currentProfile && <Check className="h-4 w-4 text-accent-cyan" />}
              </div>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}

export default SelectionSwitcher;