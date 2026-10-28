// Returns the URL of a media, with its file name encoded
export const getMediaUrl = (media) => {
  try {
    return media.url.replace(
      media.filename,
      encodeURIComponent(media.filename),
    );
  } catch (error) {
    console.error("Invalid media URL:", media, error);
    return media.url;
  }
};

// Formats a duration in seconds as m:ss
export const formatTime = (seconds) => {
  const s = Math.floor(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

// Tracks the smoothed velocity of a pointer along one axis (in px/ms), which is positive
// when moving towards lower coordinates (up or left)
export const trackVelocity = (tracker, position, timeStamp) => {
  const elapsed = timeStamp - tracker.lastTime;
  if (elapsed > 0)
    tracker.velocity =
      0.8 * ((tracker.lastPosition - position) / elapsed) +
      0.2 * tracker.velocity;
  tracker.lastPosition = position;
  tracker.lastTime = timeStamp;
};
