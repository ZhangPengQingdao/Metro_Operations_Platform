import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface FloatingSize {
  width: number;
  height: number;
}

export interface FloatingAnchorRect extends FloatingSize {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface FloatingPositionOptions {
  viewportWidth: number;
  viewportHeight: number;
  align?: 'start' | 'end';
  gap?: number;
  margin?: number;
}

export interface FloatingPosition {
  top: number;
  left: number;
  placement: 'top' | 'bottom';
}

export function calculateFloatingPosition(
  anchor: FloatingAnchorRect,
  floating: FloatingSize,
  options: FloatingPositionOptions
): FloatingPosition {
  const gap = options.gap ?? 8;
  const margin = options.margin ?? 12;
  const availableBelow = options.viewportHeight - anchor.bottom - gap - margin;
  const availableAbove = anchor.top - gap - margin;
  const placement = floating.height > availableBelow && availableAbove > availableBelow
    ? 'top'
    : 'bottom';
  const desiredTop = placement === 'top'
    ? anchor.top - gap - floating.height
    : anchor.bottom + gap;
  const desiredLeft = (options.align ?? 'start') === 'end'
    ? anchor.right - floating.width
    : anchor.left;
  const maxTop = Math.max(margin, options.viewportHeight - margin - floating.height);
  const maxLeft = Math.max(margin, options.viewportWidth - margin - floating.width);

  return {
    top: Math.min(Math.max(margin, desiredTop), maxTop),
    left: Math.min(Math.max(margin, desiredLeft), maxLeft),
    placement
  };
}

export function resolveFloatingPortalHost(anchor: HTMLElement | null): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return anchor?.closest<HTMLDialogElement>('dialog[open]') ?? document.body;
}

export interface FloatingPortalProps {
  open: boolean;
  inheritTheme?: boolean;
  anchorRef: React.RefObject<HTMLElement | null>;
  onDismiss: () => void;
  width: number;
  align?: 'start' | 'end';
  gap?: number;
  margin?: number;
  ariaLabel: string;
  className?: string;
  children: React.ReactNode;
}

export function FloatingPortal({
  open,
  inheritTheme = false,
  anchorRef,
  onDismiss,
  width,
  align = 'start',
  gap = 8,
  margin = 12,
  ariaLabel,
  className = '',
  children
}: FloatingPortalProps) {
  const [floatingElement, setFloatingElement] = useState<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<FloatingPosition>({ top: 0, left: 0, placement: 'bottom' });
  const [positioned, setPositioned] = useState(false);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const portalHost = open ? resolveFloatingPortalHost(anchorRef.current) : null;

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const element = floatingElement;
    if (!open || !anchor || !element) return;

    if (typeof element.showPopover === 'function' && !isPopoverOpen(element)) {
      element.showPopover();
    }

    const updatePosition = () => {
      if (inheritTheme) {
        const style = getComputedStyle(anchor);
        for (const name of Array.from(style)) if (name.startsWith('--afc-')) element.style.setProperty(name, style.getPropertyValue(name));
        element.style.colorScheme = style.colorScheme;
      }
      const anchorRect = anchor.getBoundingClientRect();
      const floatingRect = element.getBoundingClientRect();
      setPosition(calculateFloatingPosition(anchorRect, floatingRect, {
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        align,
        gap,
        margin
      }));
      setPositioned(true);
    };
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && (anchor.contains(target) || element.contains(target))) return;
      onDismissRef.current();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismissRef.current();
    };

    updatePosition();
    const frame = window.requestAnimationFrame(updatePosition);
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updatePosition);
    observer?.observe(anchor);
    observer?.observe(element);
    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    window.visualViewport?.addEventListener('resize', updatePosition);
    window.visualViewport?.addEventListener('scroll', updatePosition);

    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
      window.visualViewport?.removeEventListener('resize', updatePosition);
      window.visualViewport?.removeEventListener('scroll', updatePosition);
      if (typeof element.hidePopover === 'function' && isPopoverOpen(element)) {
        element.hidePopover();
      }
      setPositioned(false);
    };
  }, [align, anchorRef, floatingElement, gap, margin, open, inheritTheme]);

  if (!open || !portalHost) return null;

  return createPortal(
    <div
      ref={setFloatingElement}
      popover="manual"
      role="dialog"
      aria-label={ariaLabel}
      data-placement={position.placement}
      className={`fixed m-0 ${className}`}
      style={{
        inset: 'auto',
        top: position.top,
        left: position.left,
        width: `min(${width}px, calc(100vw - ${margin * 2}px))`,
        maxHeight: `calc(100vh - ${margin * 2}px)`,
        visibility: positioned ? 'visible' : 'hidden'
      }}
    >
      {children}
    </div>,
    portalHost
  );
}

function isPopoverOpen(element: HTMLElement) {
  try {
    return element.matches(':popover-open');
  } catch {
    return false;
  }
}
