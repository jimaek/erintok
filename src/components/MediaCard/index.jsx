// Dependencies
import { useCallback, useRef } from "react";

// Assets
import "./index.css";

const MediaCard = ({ refForwarder }) => {
  const cardRef = useRef(null);

  const forward = useCallback((_ref) => {
    cardRef.current = _ref;
    refForwarder(_ref);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="media" ref={forward}>
      <video
        className="player media-video"
        playsInline={true}
        preload="auto"
        hidden
      />
      <img className="player media-image" alt="" draggable={false} hidden />
    </div>
  );
};

export default MediaCard;
