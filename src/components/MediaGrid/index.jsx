// Dependencies
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

// Assets
import {
  faChevronLeft,
  faImage,
  faPlay,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { formatTime, getMediaUrl, trackVelocity } from "../../utils";
import "./index.css";

// A swipe opens or closes the grid when it's long enough (relative to the grid's width), or a flick
const SWIPE_DISTANCE_RATIO = 0.25;
const SWIPE_VELOCITY_PX_PER_MS = 0.3;
const TAP_MOVE_TOLERANCE_PX = 10;

const GridTile = ({ media, index, onSelect }) => {
  const [duration, setDuration] = useState(null);

  // Thumbnails are loaded by the grid, only when they're close to the visible area
  return (
    <li>
      <button
        type="button"
        className="media-grid-tile"
        aria-label={media.title}
        onClick={(event) => onSelect(index, event)}
      >
        {media.type === "image" ? (
          <img
            className="media-grid-thumbnail"
            data-index={index}
            alt=""
            draggable={false}
          />
        ) : (
          <video
            className="media-grid-thumbnail"
            data-index={index}
            muted
            playsInline
            preload="metadata"
            onLoadedMetadata={(event) => setDuration(event.target.duration)}
          />
        )}
        <span className="media-grid-tile-info">
          <FontAwesomeIcon icon={media.type === "image" ? faImage : faPlay} />
          {Number.isFinite(duration) && formatTime(duration)}
        </span>
      </button>
    </li>
  );
};

// A TikTok-like profile page that shows all the media, in the same order as the feed.
// It's revealed by swiping the feed to the left (see VideoFeed), and closed by swiping it to the right
const MediaGrid = forwardRef(({ videos, onOpen, onClose }, ref) => {
  const panelRef = useRef();
  const headerRef = useRef();
  const listRef = useRef();

  // Members - Open state, and position from 0 (closed) to 1 (open) while swiping
  const isOpen = useRef(false);
  const position = useRef(0);

  // Members - Swipe to close, and clicks to ignore after a swipe
  const gesture = useRef(null);
  const wasDragged = useRef(false);

  const thumbnailObserver = useRef(null);

  // Named after the current playlist (folder) if any
  const playlist = window
    ._decodeURIComponentSafe(window.location.pathname)
    .split("/")
    .filter(Boolean)
    .at(-1);
  const title = playlist || "All videos";

  // Loads the thumbnails close to the visible area, and unloads the others
  const observeThumbnails = () => {
    if (thumbnailObserver.current) return;

    thumbnailObserver.current = new IntersectionObserver(
      (entries) => {
        entries.forEach(({ target, isIntersecting }) => {
          const media = videos[parseInt(target.dataset.index)];
          if (isIntersecting)
            target.src =
              media.type === "video"
                ? `${getMediaUrl(media)}#t=0.1`
                : getMediaUrl(media);
          else if (target.hasAttribute("src")) {
            target.removeAttribute("src");
            if (media.type === "video") target.load();
          }
        });
      },
      { root: panelRef.current, rootMargin: "50% 0px" },
    );

    listRef.current
      .querySelectorAll(".media-grid-thumbnail")
      .forEach((thumbnail) => thumbnailObserver.current.observe(thumbnail));
  };

  // Marks the media shown in the feed
  const setCurrent = (index) => {
    listRef.current
      .querySelector(".is-current")
      ?.classList.remove("is-current");
    listRef.current.children[index]?.classList.add("is-current");
  };

  const scrollToCurrent = () => {
    const tile = listRef.current.querySelector(".is-current");
    if (!tile) return;

    const panelRect = panelRef.current.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    if (
      tileRect.top >= panelRect.top + headerRef.current.offsetHeight &&
      tileRect.bottom <= panelRect.bottom
    )
      return;

    panelRef.current.scrollTop +=
      tileRect.top - panelRect.top - (panelRect.height - tileRect.height) / 2;
  };

  // Moves the grid with the finger
  const follow = (progress) => {
    const panel = panelRef.current;
    if (!panel.classList.contains("is-shown")) {
      panel.classList.add("is-shown");
      scrollToCurrent();
      observeThumbnails();
    }

    position.current = Math.max(0, Math.min(1, progress));
    panel.classList.add("is-dragging");
    panel.style.transform = `translateX(${(1 - position.current) * 100}%)`;
  };

  // Animates the grid open or closed, and reports the change (with the media picked, if any)
  const settle = (open, selectedIndex = null) => {
    const panel = panelRef.current;
    panel.classList.remove("is-dragging");
    panel.classList.toggle("is-shown", open);
    panel.style.transform = open ? "translateX(0%)" : "";
    position.current = open ? 1 : 0;

    if (open === isOpen.current) return;
    isOpen.current = open;

    // The browser's back button and gesture close the grid
    if (open) {
      if (!window.history.state?.erinGrid)
        window.history.pushState({ erinGrid: true }, "");
      onOpen();
    } else {
      if (window.history.state?.erinGrid) window.history.back();
      onClose(selectedIndex);
    }
  };

  // Opens or closes the grid after a long enough swipe or a flick, or goes back otherwise.
  // The velocity (in px/ms) is positive towards the left, i.e. when opening
  const release = (velocity) => {
    const moved = position.current - (isOpen.current ? 1 : 0);
    const isFlick =
      Math.abs(velocity) > SWIPE_VELOCITY_PX_PER_MS &&
      Math.sign(velocity) === Math.sign(moved);
    const toggles = Math.abs(moved) > SWIPE_DISTANCE_RATIO || isFlick;
    settle(toggles ? !isOpen.current : isOpen.current);
  };

  useImperativeHandle(ref, () => ({
    follow,
    release,
    setCurrent,
    isOpen: () => isOpen.current,
  }));

  // Gestures - Swipe right to close the grid (vertical swipes scroll it natively)
  const handlePointerDown = (event) => {
    wasDragged.current = false;
    if (!isOpen.current || event.button > 0) return;

    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      swiping: false,
      lastPosition: event.clientX,
      lastTime: event.timeStamp,
      velocity: 0,
    };
  };

  const handlePointerMove = (event) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;

    if (!current.swiping) {
      const dx = event.clientX - current.x;
      const dy = event.clientY - current.y;
      if (Math.hypot(dx, dy) <= TAP_MOVE_TOLERANCE_PX) return;

      wasDragged.current = true;
      if (dx <= 0 || Math.abs(dx) <= Math.abs(dy)) {
        gesture.current = null;
        return;
      }
      current.swiping = true;
    }

    trackVelocity(current, event.clientX, event.timeStamp);
    follow(1 - (event.clientX - current.x) / panelRef.current.clientWidth);
  };

  const handlePointerUp = (event) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;

    gesture.current = null;
    if (!current.swiping) return;

    // A finger that stopped before being lifted isn't a flick
    if (event.timeStamp - current.lastTime > 100) current.velocity = 0;
    release(current.velocity);
  };

  const handlePointerCancel = (event) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;

    gesture.current = null;
    if (current.swiping) release(0);
  };

  // Ignores the click that ends a swipe (keyboard clicks have no detail)
  const handleSelect = (index, event) => {
    if (!isOpen.current || (wasDragged.current && event.detail)) return;
    settle(false, index);
  };

  // Hook - On mount - Close the grid with the Escape key and the browser's back button
  useEffect(() => {
    // After a reload, the browser restores the history entry of an open grid
    if (window.history.state?.erinGrid) window.history.replaceState(null, "");

    const handleKeyDown = (event) => {
      if (event.code === "Escape" && isOpen.current) settle(false);
    };
    const handlePopState = () => {
      if (isOpen.current && !window.history.state?.erinGrid) settle(false);
    };

    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("popstate", handlePopState);

    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("popstate", handlePopState);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hook - When media change - Observe the new thumbnails on the next opening
  useEffect(
    () => () => {
      thumbnailObserver.current?.disconnect();
      thumbnailObserver.current = null;
    },
    [videos],
  );

  return (
    <div
      ref={panelRef}
      className="media-grid"
      role="dialog"
      aria-label={title}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerCancel}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div ref={headerRef} className="media-grid-header">
        <button
          type="button"
          className="media-grid-back"
          aria-label="Back to the feed"
          onClick={() => isOpen.current && settle(false)}
        >
          <FontAwesomeIcon icon={faChevronLeft} />
        </button>
        <h2>{title}</h2>
      </div>
      <div className="media-grid-profile">
        <img src="/logo.png" alt="" draggable={false} />
        <p>
          <strong>{videos.length}</strong>{" "}
          {videos.length === 1 ? "post" : "posts"}
        </p>
      </div>
      <ul ref={listRef} className="media-grid-tiles">
        {videos.map((media, index) => (
          <GridTile
            key={media.url}
            media={media}
            index={index}
            onSelect={handleSelect}
          />
        ))}
      </ul>
    </div>
  );
});

export default MediaGrid;
