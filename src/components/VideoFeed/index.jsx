import { forwardRef, useEffect, useRef } from "react";
import MediaCard from "../MediaCard";
import "./index.css";

const VideoFeed = forwardRef(
  (
    {
      videos,
      initialIndex,
      jumpToEnd,
      jumpBackForward,
      muted,
      onFocusVideo,
      onPlaybackStateChange,
    },
    ref,
  ) => {
  const _bufferSize = 3;
  const normalizedInitialIndex =
    _bufferSize === videos.length ? 0 : initialIndex;

  // Member - Track the currently-visible media item (0-indexed)
  const currentMediaIndex = useRef(normalizedInitialIndex);

  // Member - Track the currently-visible stable card wrapper
  const currentMediaCard = useRef(null);

  // Member - References to feed UI elements
  const feedRef = useRef();
  const progressRef = useRef();
  const padRef = useRef();
  const trackRef = useRef();
  const timeRef = useRef();
  const speedRef = useRef();

  // Member - Save the three stable card wrappers in recycler order
  const cardRefs = useRef([]);
  const saveCardRef = (index) => (card) => {
    cardRefs.current[index] = card;
  };

  // Member - Image timeline and video listener state
  const imageAnimationFrame = useRef(null);
  const imageTimelineGeneration = useRef(0);
  const imageElapsedMs = useRef(0);
  const imageStartedAt = useRef(null);
  const imageIsPlaying = useRef(false);
  const videoListeners = useRef(new Map());
  const wasPlayingBeforeScrub = useRef(false);
  const isScrubbing = useRef(false);
  const mutedRef = useRef(muted);
  mutedRef.current = muted;

  // Member - Prevent double jump forward
  const hasJumpedForward = useRef(false);

  // Members - Tap (play / pause), hold (fast forward) and swipe gestures
  const gesture = useRef(null);
  const snapAnimation = useRef(null);

  const imageDurationMs = window.IMAGE_DISPLAY_DURATION * 1000;

  const setProgress = (elapsed, duration) => {
    if (!progressRef.current || !Number.isFinite(duration) || duration <= 0)
      return;

    const progressRate = Math.max(0, Math.min(1, elapsed / duration));
    progressRef.current.style.width = `${progressRate * 100}%`;
  };

  const isFocusedCard = (card, index) =>
    currentMediaCard.current === card &&
    currentMediaIndex.current === index &&
    parseInt(card.dataset.index) === index;

  const isCardVisible = (card) => {
    if (!feedRef.current) return false;

    const cardRect = card.getBoundingClientRect();
    const feedRect = feedRef.current.getBoundingClientRect();
    const visibleHeight =
      Math.min(cardRect.bottom, feedRect.bottom) -
      Math.max(cardRect.top, feedRect.top);
    return visibleHeight / cardRect.height >= 0.95;
  };

  const stopImageTimeline = (freeze = true) => {
    imageTimelineGeneration.current += 1;
    if (imageAnimationFrame.current !== null) {
      cancelAnimationFrame(imageAnimationFrame.current);
      imageAnimationFrame.current = null;
    }

    if (freeze && imageIsPlaying.current && imageStartedAt.current !== null) {
      imageElapsedMs.current = Math.min(
        imageDurationMs,
        imageElapsedMs.current + performance.now() - imageStartedAt.current,
      );
    }

    imageStartedAt.current = null;
    imageIsPlaying.current = false;
  };

  const startImageTimeline = (reset = false) => {
    const card = currentMediaCard.current;
    const index = currentMediaIndex.current;
    if (!card || card.dataset.mediaType !== "image") return;

    stopImageTimeline(false);
    if (reset) imageElapsedMs.current = 0;

    imageIsPlaying.current = true;
    imageStartedAt.current = performance.now();
    onPlaybackStateChange(true);

    const generation = imageTimelineGeneration.current;
    const tick = (now) => {
      if (
        generation !== imageTimelineGeneration.current ||
        !isFocusedCard(card, index) ||
        card.dataset.mediaType !== "image"
      )
        return;

      const elapsed = imageElapsedMs.current + now - imageStartedAt.current;
      if (elapsed >= imageDurationMs) {
        stopImageTimeline(false);
        imageElapsedMs.current = 0;
        setProgress(0, imageDurationMs);
        finishMedia();

        if (isFocusedCard(card, index) && card.dataset.mediaType === "image")
          startImageTimeline();
        return;
      }

      setProgress(elapsed, imageDurationMs);
      imageAnimationFrame.current = requestAnimationFrame(tick);
    };

    imageAnimationFrame.current = requestAnimationFrame(tick);
  };

  const removeVideoListeners = (video) => {
    const listeners = videoListeners.current.get(video);
    if (!listeners) return;

    Object.entries(listeners).forEach(([eventName, listener]) => {
      video.removeEventListener(eventName, listener, true);
    });
    videoListeners.current.delete(video);
  };

  const stopCardPlayback = (card) => {
    if (!card) return;

    const video = card.querySelector("video");
    removeVideoListeners(video);
    video.pause();

    if (
      currentMediaCard.current === card &&
      card.dataset.mediaType === "image"
    )
      stopImageTimeline();
  };

  // Assign both initial and recycled cards through the same cleanup and loading path.
  const assignMedia = (card, index) => {
    if (!card) return;

    stopCardPlayback(card);

    const video = card.querySelector("video");
    const image = card.querySelector("img");
    video.removeAttribute("src");
    video.load();
    image.removeAttribute("src");

    const media = videos[index];
    card.dataset.index = index;
    card.dataset.mediaType = media ? media.type : "";
    video.hidden = !media || media.type !== "video";
    image.hidden = !media || media.type !== "image";

    if (!media) return;

    let safeUrl = media.url;
    try {
      safeUrl = media.url.replace(
        media.filename,
        encodeURIComponent(media.filename),
      );
    } catch (error) {
      console.error("Invalid URL in MediaCard:", media, error);
    }

    if (media.type === "image") {
      image.alt = media.title;
      image.src = safeUrl;
    } else {
      video.muted = mutedRef.current;
      video.src = safeUrl;
    }
  };

  const focusCard = (card, index) => {
    if (!videos[index] || parseInt(card.dataset.index) !== index) return;
    if (isFocusedCard(card, index)) return;

    const previousCard = currentMediaCard.current;
    if (previousCard) stopCardPlayback(previousCard);

    currentMediaCard.current = card;
    currentMediaIndex.current = index;
    setProgress(0, 1);
    onFocusVideo(videos[index], index);

    if (card.dataset.mediaType === "image") {
      imageElapsedMs.current = 0;
      startImageTimeline(true);
      return;
    }

    const video = card.querySelector("video");
    video.muted = mutedRef.current;

    const listeners = {
      timeupdate: (event) => {
        if (!isFocusedCard(card, index)) return;
        setProgress(event.target.currentTime, event.target.duration);
      },
      ended: (event) => {
        if (!isFocusedCard(card, index)) return;
        event.target.play().catch((_) => {
          if (isFocusedCard(card, index)) onPlaybackStateChange(false);
        });
        finishMedia();
      },
      play: () => {
        if (isFocusedCard(card, index)) onPlaybackStateChange(true);
      },
      pause: () => {
        if (isFocusedCard(card, index)) onPlaybackStateChange(false);
      },
    };

    if (window.VIDEO_START_POSITION !== "start") {
      listeners.loadedmetadata = (event) => {
        if (!isFocusedCard(card, index)) return;
        event.target.currentTime =
          window.VIDEO_START_POSITION === "middle"
            ? event.target.duration / 2
            : Math.random() * event.target.duration;
        event.target.removeEventListener(
          "loadedmetadata",
          listeners.loadedmetadata,
          true,
        );
      };
    }

    Object.entries(listeners).forEach(([eventName, listener]) => {
      video.addEventListener(eventName, listener, true);
    });
    videoListeners.current.set(video, listeners);

    if (listeners.loadedmetadata && video.readyState >= 1)
      listeners.loadedmetadata({ target: video });

    video.play().catch((_) => {
      if (isFocusedCard(card, index)) onPlaybackStateChange(false);
    });
  };

  const pausePlayback = () => {
    const card = currentMediaCard.current;
    if (!card) return;

    if (card.dataset.mediaType === "image") {
      stopImageTimeline();
      setProgress(imageElapsedMs.current, imageDurationMs);
      onPlaybackStateChange(false);
    } else {
      card.querySelector("video").pause();
    }
  };

  const playPlayback = () => {
    const card = currentMediaCard.current;
    if (!card) return;

    if (card.dataset.mediaType === "image") {
      if (imageElapsedMs.current >= imageDurationMs)
        imageElapsedMs.current = 0;
      startImageTimeline();
    } else {
      const video = card.querySelector("video");
      const index = currentMediaIndex.current;
      video.play().catch((_) => {
        if (isFocusedCard(card, index)) onPlaybackStateChange(false);
      });
    }
  };

  const togglePlayback = () => {
    const card = currentMediaCard.current;
    if (!card) return;

    if (card.dataset.mediaType === "image") {
      if (imageIsPlaying.current) pausePlayback();
      else playPlayback();
      return;
    }

    const video = card.querySelector("video");
    if (video.paused) playPlayback();
    else pausePlayback();
  };

  // Hook - Keep the global mute setting applied to the focused video.
  useEffect(() => {
    const card = currentMediaCard.current;
    if (card && card.dataset.mediaType === "video")
      card.querySelector("video").muted = muted;
  }, [muted]);

  // Hook - On mount - Set the current scroll
  useEffect(() => {
    if (jumpToEnd) return feedRef.current.scrollBy({ top: 1, left: 0 });
    if (jumpBackForward) {
      if (!hasJumpedForward.current) {
        hasJumpedForward.current = true;
        return feedRef.current.scrollBy({ top: 1, left: 0 });
      }

      hasJumpedForward.current = false;
    }
  }, [normalizedInitialIndex, jumpBackForward, jumpToEnd]);

  // Hook - When media are loaded - Set up the stable-card scroll observer
  useEffect(() => {
    cardRefs.current.forEach((card, offset) => {
      assignMedia(card, normalizedInitialIndex + offset);
    });

    const observer = new IntersectionObserver(
      (entries) => {
        let visibleEntry = null;

        entries.forEach((entry) => {
          const index = parseInt(entry.target.dataset.index);
          if (
            entry.isIntersecting &&
            isCardVisible(entry.target) &&
            videos[index] &&
            entry.target.dataset.mediaType === videos[index].type
          ) {
            visibleEntry = entry;
          } else if (
            !entry.isIntersecting &&
            currentMediaCard.current === entry.target
          ) {
            stopCardPlayback(entry.target);
            currentMediaCard.current = null;
          }
        });

        if (!visibleEntry) return;

        const card = visibleEntry.target;
        const currentIndex = parseInt(card.dataset.index);
        const previousIndex = currentMediaIndex.current;
        focusCard(card, currentIndex);

        if (videos.length <= 1 || previousIndex === currentIndex) return;

        const scrollDirection =
          currentIndex > previousIndex ? "next" : "prev";
        const cardRect = cardRefs.current[1].getBoundingClientRect();
        const padHeight = cardRect.height * (currentIndex - 1);

        if (scrollDirection === "next") {
          if (currentIndex > 1 && currentIndex < videos.length - 1) {
            const firstCard = cardRefs.current.shift();
            cardRefs.current.push(firstCard);

            padRef.current.style.height = `${padHeight}px`;

            cardRefs.current[_bufferSize - 2].insertAdjacentElement(
              "afterend",
              firstCard,
            );
            assignMedia(firstCard, currentIndex + 1);
          }
        } else if (previousIndex > 1 && previousIndex < videos.length - 1) {
          const lastCard = cardRefs.current.at(-1);
          cardRefs.current.unshift(lastCard);
          cardRefs.current.splice(-1);

          cardRefs.current[1].insertAdjacentElement("beforebegin", lastCard);

          padRef.current.style.height = `${padHeight}px`;

          assignMedia(lastCard, currentIndex - 1);
        }
      },
      { root: null, rootMargin: "0px", threshold: 0.95 },
    );

    cardRefs.current.forEach((card) => {
      if (card) observer.observe(card);
    });

    return () => {
      observer.disconnect();
      stopImageTimeline(false);
      cardRefs.current.forEach((card) => stopCardPlayback(card));
      currentMediaCard.current = null;
    };
  }, [videos]); // eslint-disable-line react-hooks/exhaustive-deps

  const seekBy = (seconds) => {
    const card = currentMediaCard.current;
    if (!card) return;

    if (card.dataset.mediaType === "image") {
      const currentElapsed = imageIsPlaying.current
        ? imageElapsedMs.current + performance.now() - imageStartedAt.current
        : imageElapsedMs.current;
      imageElapsedMs.current = Math.max(
        0,
        Math.min(imageDurationMs, currentElapsed + seconds * 1000),
      );
      if (imageIsPlaying.current) imageStartedAt.current = performance.now();
      setProgress(imageElapsedMs.current, imageDurationMs);
      return;
    }

    const video = card.querySelector("video");
    video.currentTime += seconds;
  };

  const handleKeyboardSeeking = (event) => {
    if (event.code === "Space") {
      event.preventDefault();
      togglePlayback();
    } else if (event.code === "ArrowRight") seekBy(5);
    else if (event.code === "ArrowLeft") seekBy(-5);
    else if (event.code === "ArrowDown") snapBy(1);
    else if (event.code === "ArrowUp") snapBy(-1);
  };

  // Gestures - Tap anywhere to play / pause, hold the left or right side to fast forward,
  // and swipe to change media. Touch swipes are handled here rather than by native scrolling,
  // so that short flicks change media, and the snap animation is as quick as TikTok's
  const HOLD_DELAY_MS = 300;
  const FAST_FORWARD_RATE = 5;
  const HOLD_SIDE_RATIO = 0.3;
  const TAP_MOVE_TOLERANCE_PX = 10;
  const SWIPE_DISTANCE_RATIO = 0.15;
  const SWIPE_VELOCITY_PX_PER_MS = 0.3;
  const SNAP_DURATION_MS = 250;
  const getCardSize = () => feedRef.current.clientHeight;

  // Returns whether an animation was stopped
  const stopSnapAnimation = () => {
    if (!snapAnimation.current) return false;

    cancelAnimationFrame(snapAnimation.current);
    snapAnimation.current = null;
    return true;
  };

  // Scrolls to the n-th snap position, with native snapping disabled meanwhile
  const snapTo = (index) => {
    const feed = feedRef.current;
    const size = getCardSize();
    const maxScroll = feed.scrollHeight - feed.clientHeight;
    const from = feed.scrollTop;
    const to = Math.max(0, Math.min(Math.round(maxScroll / size), index)) * size;
    const startedAt = performance.now();

    stopSnapAnimation();
    feed.classList.add("is-swiping");

    const step = (now) => {
      const progress = Math.min(1, (now - startedAt) / SNAP_DURATION_MS);
      feed.scrollTop = from + (to - from) * (1 - (1 - progress) ** 3);

      if (progress < 1) snapAnimation.current = requestAnimationFrame(step);
      else {
        snapAnimation.current = null;
        feed.classList.remove("is-swiping");
      }
    };
    snapAnimation.current = requestAnimationFrame(step);
  };

  const snapBy = (offset) =>
    snapTo(Math.round(feedRef.current.scrollTop / getCardSize()) + offset);

  // Autoplay - Go to the next media when the current one ends (unless it's being touched)
  const finishMedia = () => {
    if (window.AUTOPLAY_ENABLED && !gesture.current && !isScrubbing.current)
      snapBy(1);
  };

  // Snaps to the next / previous media after a long enough swipe or a flick, or back otherwise
  const settleSwipe = (swipe) => {
    const size = getCardSize();
    const scroll = feedRef.current.scrollTop;
    if (!swipe?.active) return snapTo(Math.round(scroll / size));

    const moved = scroll - swipe.startScroll;
    const isFlick =
      Math.abs(swipe.velocity) > SWIPE_VELOCITY_PX_PER_MS &&
      Math.sign(swipe.velocity) === Math.sign(moved);
    const offset =
      Math.abs(moved) > size * SWIPE_DISTANCE_RATIO || isFlick
        ? Math.sign(moved)
        : 0;
    snapTo(Math.round(swipe.startScroll / size) + offset);
  };

  const stopFastForward = (video) => {
    video.playbackRate = 1;
    speedRef.current.classList.remove("is-visible");
  };

  const handleGestureStart = (event) => {
    if (event.button > 0 || event.target.closest(".video-track")) return;

    // Touching the screen during a snap animation stops it, so that it can be swiped again right away
    const interruptedSnap = stopSnapAnimation();

    const { left, width } = feedRef.current.getBoundingClientRect();
    const position = (event.clientX - left) / width;
    const isOnSide =
      position < HOLD_SIDE_RATIO || position > 1 - HOLD_SIDE_RATIO;

    gesture.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      video: null,
      interruptedSnap,
      // Mouse users scroll with the wheel or the keyboard instead
      swipe:
        event.pointerType === "mouse"
          ? null
          : {
              active: false,
              startScroll: feedRef.current.scrollTop,
              startPosition: event.clientY,
              lastPosition: event.clientY,
              lastTime: event.timeStamp,
              velocity: 0,
            },
      holdTimer:
        isOnSide && !interruptedSnap
          ? setTimeout(() => {
              const card = currentMediaCard.current;
              if (!gesture.current || card?.dataset.mediaType !== "video")
                return;

              const video = card.querySelector("video");
              gesture.current.video = video;
              video.playbackRate = FAST_FORWARD_RATE;
              if (video.paused) playPlayback();
              speedRef.current.classList.add("is-visible");
            }, HOLD_DELAY_MS)
          : null,
    };
  };

  const handleGestureMove = (event) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId || current.video)
      return;

    const { swipe } = current;
    if (!swipe?.active) {
      const distance = Math.hypot(
        event.clientX - current.x,
        event.clientY - current.y,
      );
      if (distance <= TAP_MOVE_TOLERANCE_PX) return;

      // Moving cancels the tap and the hold, and starts swiping
      clearTimeout(current.holdTimer);
      if (!swipe) {
        gesture.current = null;
        return;
      }
      swipe.active = true;
      feedRef.current.classList.add("is-swiping");
    }

    // Follow the finger, by at most one media
    const position = event.clientY;
    const elapsed = event.timeStamp - swipe.lastTime;
    if (elapsed > 0)
      swipe.velocity =
        0.8 * ((swipe.lastPosition - position) / elapsed) +
        0.2 * swipe.velocity;
    swipe.lastPosition = position;
    swipe.lastTime = event.timeStamp;

    const size = getCardSize();
    const moved = Math.max(
      -size,
      Math.min(size, swipe.startPosition - position),
    );
    feedRef.current.scrollTop = swipe.startScroll + moved;
  };

  const handleGestureEnd = (event) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;

    gesture.current = null;
    clearTimeout(current.holdTimer);

    if (current.video) stopFastForward(current.video);
    else if (current.swipe?.active || current.interruptedSnap) {
      // A finger that stopped before being lifted isn't a flick
      if (current.swipe && event.timeStamp - current.swipe.lastTime > 100)
        current.swipe.velocity = 0;
      settleSwipe(current.swipe);
    } else togglePlayback();
  };

  const handleGestureCancel = (event) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;

    gesture.current = null;
    clearTimeout(current.holdTimer);

    if (current.video) stopFastForward(current.video);
    if (current.swipe?.active || current.interruptedSnap)
      settleSwipe(current.swipe);
  };

  // Scrubbing - Press or drag anywhere on the track to seek (TikTok-like)
  const formatTime = (seconds) => {
    const s = Math.floor(seconds);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };

  const scrubTo = (clientX) => {
    const card = currentMediaCard.current;
    if (!card) return;

    const duration =
      card.dataset.mediaType === "image"
        ? window.IMAGE_DISPLAY_DURATION
        : card.querySelector("video").duration;
    if (!Number.isFinite(duration) || duration <= 0) return;

    const { left, width } = trackRef.current.getBoundingClientRect();
    const time =
      Math.max(0, Math.min(1, (clientX - left) / width)) * duration;

    if (card.dataset.mediaType === "image")
      imageElapsedMs.current = time * 1000;
    else card.querySelector("video").currentTime = time;

    setProgress(time, duration);
    timeRef.current.textContent = `${formatTime(time)} / ${formatTime(duration)}`;
  };

  const handleScrubStart = (event) => {
    const card = currentMediaCard.current;
    if (!card || event.button > 0) return;

    // Keep receiving the pointer's events while it's dragged outside the track
    event.preventDefault();
    trackRef.current.setPointerCapture(event.pointerId);
    isScrubbing.current = true;
    document.body.classList.add("is-scrubbing");

    wasPlayingBeforeScrub.current =
      card.dataset.mediaType === "image"
        ? imageIsPlaying.current
        : !card.querySelector("video").paused;
    pausePlayback();
    scrubTo(event.clientX);
  };

  const handleScrubMove = (event) => {
    if (isScrubbing.current) scrubTo(event.clientX);
  };

  const handleScrubEnd = () => {
    if (!isScrubbing.current) return;

    isScrubbing.current = false;
    document.body.classList.remove("is-scrubbing");
    if (wasPlayingBeforeScrub.current) playPlayback();
  };

  useEffect(() => {
    document.addEventListener("keydown", handleKeyboardSeeking);

    return () => {
      document.removeEventListener("keydown", handleKeyboardSeeking);
      document.body.classList.remove("is-scrubbing");
      clearTimeout(gesture.current?.holdTimer);
      stopSnapAnimation();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div
      ref={feedRef}
      className="feed"
      key={new Date().getTime()}
      onPointerDown={handleGestureStart}
      onPointerMove={handleGestureMove}
      onPointerUp={handleGestureEnd}
      onPointerCancel={handleGestureCancel}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div ref={padRef} className="feed-pad-top"></div>
      {[...Array(Math.min(_bufferSize, videos.length)).keys()].map((slot) => (
        <MediaCard key={slot} refForwarder={saveCardRef(slot)} />
      ))}
      <div ref={speedRef} className="speed-indicator">
        {FAST_FORWARD_RATE}x
      </div>
      <div
        ref={trackRef}
        className={`video-track ${window.PROGRESS_BAR_POSITION}`}
        onPointerDown={handleScrubStart}
        onPointerMove={handleScrubMove}
        onPointerUp={handleScrubEnd}
        onPointerCancel={handleScrubEnd}
      >
        <div className="video-track-line">
          <div className="video-track-progress" ref={progressRef}>
            <i className="video-track-thumb" />
          </div>
        </div>
      </div>
      <div
        ref={timeRef}
        className={`video-track-time ${window.PROGRESS_BAR_POSITION}`}
      />
    </div>
  );
  },
);

export default VideoFeed;
