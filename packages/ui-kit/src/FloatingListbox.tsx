import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Ref,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

export const FLOATING_LISTBOX_GAP = 4;
export const FLOATING_LISTBOX_VIEWPORT_MARGIN = 8;
export const FLOATING_LISTBOX_MAX_HEIGHT = 240;

export interface FloatingListboxAnchorRect {
  top: number;
  right: number;
  bottom: number;
  left: number;
  width: number;
}

export interface FloatingListboxPlacementInput {
  anchorRect: FloatingListboxAnchorRect;
  /** The list's full, un-clipped content height. */
  listHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  gap?: number;
  viewportMargin?: number;
  maxHeight?: number;
}

export interface FloatingListboxPlacement {
  side: "above" | "below";
  top: number;
  left: number;
  width: number;
  maxHeight: number;
}

/**
 * Place a listbox against its anchor in viewport coordinates. The menu keeps
 * the anchor's width and prefers the space below it. If its content would not
 * fit there and the upper side has more room, it flips above; whichever side
 * wins is clipped to the viewport and to the shared 240px menu cap.
 */
export function calculateFloatingListboxPlacement({
  anchorRect,
  listHeight,
  viewportWidth,
  viewportHeight,
  gap = FLOATING_LISTBOX_GAP,
  viewportMargin = FLOATING_LISTBOX_VIEWPORT_MARGIN,
  maxHeight = FLOATING_LISTBOX_MAX_HEIGHT,
}: FloatingListboxPlacementInput): FloatingListboxPlacement {
  const width = Math.max(0, anchorRect.width);
  const availableBelow = Math.max(
    0,
    viewportHeight - viewportMargin - anchorRect.bottom - gap,
  );
  const availableAbove = Math.max(
    0,
    anchorRect.top - viewportMargin - gap,
  );
  const desiredHeight = Math.min(Math.max(0, listHeight), maxHeight);
  const side =
    availableBelow < desiredHeight && availableAbove > availableBelow
      ? "above"
      : "below";
  const availableHeight =
    side === "above" ? availableAbove : availableBelow;
  const resolvedMaxHeight = Math.max(
    0,
    Math.min(maxHeight, availableHeight),
  );
  const renderedHeight = Math.min(desiredHeight, resolvedMaxHeight);

  // Preserve the anchor width. When it fits in the viewport, shift it just
  // enough to respect both horizontal margins; an unusually wide anchor keeps
  // its width and starts at the leading margin.
  const furthestLeft = viewportWidth - viewportMargin - width;
  const left = Math.max(
    viewportMargin,
    Math.min(anchorRect.left, furthestLeft),
  );

  return {
    side,
    top:
      side === "above"
        ? anchorRect.top - gap - renderedHeight
        : anchorRect.bottom + gap,
    left,
    width,
    maxHeight: resolvedMaxHeight,
  };
}

export interface FloatingListboxProps
  extends Omit<ComponentPropsWithoutRef<"ul">, "role"> {
  /** Element whose viewport rectangle the portaled list follows. */
  anchorRef: RefObject<HTMLElement | null>;
  /** Optional access to the actual portaled `<ul>`. */
  listRef?: Ref<HTMLUListElement>;
}

function samePlacement(
  left: FloatingListboxPlacement | null,
  right: FloatingListboxPlacement,
) {
  return (
    left?.side === right.side &&
    left.top === right.top &&
    left.left === right.left &&
    left.width === right.width &&
    left.maxHeight === right.maxHeight
  );
}

/**
 * A non-modal top-level listbox layer. Portaling to the document body (or the
 * nearest existing overlay) keeps the menu out of its anchor's scroll/overflow
 * tree; fixed coordinates follow the anchor without intercepting interaction
 * elsewhere in the app.
 */
export function FloatingListbox({
  anchorRef,
  listRef,
  className,
  children,
  style,
  ...listProps
}: FloatingListboxProps) {
  const ownListRef = useRef<HTMLUListElement | null>(null);
  const externalRefCleanup = useRef<(() => void) | null>(null);
  const [placement, setPlacement] =
    useState<FloatingListboxPlacement | null>(null);

  const clearListRef = useCallback(() => {
    if (!ownListRef.current) return;
    ownListRef.current = null;

    const cleanup = externalRefCleanup.current;
    externalRefCleanup.current = null;
    if (cleanup) cleanup();
    else if (typeof listRef === "function") listRef(null);
    else if (listRef) listRef.current = null;
  }, [listRef]);

  const attachListRef = useCallback(
    (node: HTMLUListElement | null) => {
      if (!node) {
        clearListRef();
        return;
      }
      ownListRef.current = node;
      if (typeof listRef === "function") {
        const cleanup = listRef(node);
        externalRefCleanup.current =
          typeof cleanup === "function" ? cleanup : null;
      } else if (listRef) listRef.current = node;
      // React 19 calls this instead of invoking the callback with null. Mirror
      // that contract for the composed external ref as well.
      return clearListRef;
    },
    [clearListRef, listRef],
  );

  const recompute = useCallback(() => {
    const anchor = anchorRef.current;
    const list = ownListRef.current;
    if (!anchor || !list) return;

    const anchorRect = anchor.getBoundingClientRect();
    // Width affects wrapping and therefore scrollHeight. Apply the anchor
    // width before measuring so even the first layout is based on the menu's
    // real geometry (including in browsers without ResizeObserver).
    list.style.width = `${Math.max(0, anchorRect.width)}px`;
    const listRect = list.getBoundingClientRect();
    const next = calculateFloatingListboxPlacement({
      anchorRect,
      listHeight: Math.max(list.scrollHeight, listRect.height),
      viewportWidth:
        document.documentElement.clientWidth || window.innerWidth,
      viewportHeight:
        document.documentElement.clientHeight || window.innerHeight,
    });
    setPlacement((current) => (samePlacement(current, next) ? current : next));
  }, [anchorRef]);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const list = ownListRef.current;
    if (!anchor || !list) return;

    recompute();
    // Scroll does not bubble, so capture is what lets one listener follow an
    // anchor inside any nested scrolling container.
    window.addEventListener("scroll", recompute, true);
    window.addEventListener("resize", recompute);

    const observer = window.ResizeObserver
      ? new window.ResizeObserver(recompute)
      : null;
    observer?.observe(anchor);
    observer?.observe(list);

    return () => {
      window.removeEventListener("scroll", recompute, true);
      window.removeEventListener("resize", recompute);
      observer?.disconnect();
    };
  }, [anchorRef, recompute]);

  // A menu opened inside an existing modal/peek belongs to that overlay's
  // stacking context. Base menus stay below those overlays, so a dialog that
  // opens asynchronously can never leave an older dropdown floating above it.
  const overlayRoot = anchorRef.current?.closest<HTMLElement>(
    ".modal-overlay, .peek",
  );
  const portalRoot =
    overlayRoot ?? anchorRef.current?.ownerDocument.body ?? document.body;

  return createPortal(
    <div
      className="dropdown__layer"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: overlayRoot ? 1 : 90,
        pointerEvents: "none",
      }}
    >
      <ul
        {...listProps}
        ref={attachListRef}
        role="listbox"
        className={`dropdown__menu dropdown__menu--floating${className ? ` ${className}` : ""}`}
        style={{
          ...style,
          position: "fixed",
          top: placement?.top ?? 0,
          right: "auto",
          bottom: "auto",
          left: placement?.left ?? 0,
          width: placement?.width ?? 0,
          maxHeight: placement?.maxHeight ?? FLOATING_LISTBOX_MAX_HEIGHT,
          overflowY: "auto",
          boxSizing: "border-box",
          pointerEvents: "auto",
          visibility: placement ? "visible" : "hidden",
        }}
      >
        {children}
      </ul>
    </div>,
    portalRoot,
  );
}
