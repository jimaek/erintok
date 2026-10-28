// Dependencies
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Components
import VideoFeed from "./components/VideoFeed";

// Assets
import { faCompactDisc, faPlay } from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { usePrevious } from "@uidotdev/usehooks";
import BottomMetadata from "./components/BottomMetadata";
import "./App.css";

const App = () => {
  // Misc - General niceties
  const _reloadPage = (evt) => {
    evt.preventDefault();
    window.location.reload();
  };
  const _makeHTTPHeaders = () => {
    const headers = { Accept: "application/json" };
    if (window.USE_SECRET && !secureHash)
      headers["Authorization"] = `Basic ${btoa(`Erin:${formSecret}`)}`;
    return headers;
  };
  const _clearStoredSecret = () => {
    localStorage.removeItem("erin_secret");
  };
  const _storeSecret = (s) => {
    localStorage.setItem("erin_secret", s);
  };
  const _isVideo = (file) =>
    ["mp4", "ogg", "webm"].includes(file.name.toLowerCase().split(".").at(-1));
  const _isImage = (file) =>
    ["jpg", "jpeg", "png", "webp"].includes(
      file.name.toLowerCase().split(".").at(-1),
    );
  const _isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
  const _toAuthenticatedUrl = (url) => `${url}?hash=${secureHash}`;
  const _veryFirsPageTitle = useMemo(() => document.title, []);
  const _updatePageTitle = (media = null) => {
    if (media) {
      if (!_veryFirsPageTitle.includes("[VIDEO_TITLE]"))
        document.title = _veryFirsPageTitle;
      else
        document.title = _veryFirsPageTitle.replace(
          "[VIDEO_TITLE]",
          media.title,
        );
    } else if (window.USE_SECRET) document.title = "Erin - Authentication";
  };
  const _injectCustomStylesheet = () => {
    const node = document.createElement("link");

    node.type = "text/css";
    node.rel = "stylesheet";
    node.href = "/custom.css";

    document.head.appendChild(node);
  };
  const _shuffleArray = (arr) => {
    const copy = [...arr];

    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }

    return copy;
  };
  // Source : https://stackoverflow.com/questions/7449588/why-does-decodeuricomponent-lock-up-my-browser
  window._decodeURIComponentSafe = (s) => {
    if (!s) return s;
    return decodeURIComponent(s.replace(/%(?![0-9a-fA-F]+)/g, "%25"));
  };

  const _scrollDirection = document
    .querySelector("html")
    .getAttribute("data-scroll-direction");

  // Members - Form & Auth management
  const [autoconnect, setAutoconnect] = useState(false);
  const [hasEverSubmitted, setHasEverSubmitted] = useState(false);
  const [formSecret, setFormSecret] = useState("");
  const [secureHash, setSecureHash] = useState("");
  const handleInputSecret = (e) => setFormSecret(e.target.value);

  // Member - Determines whether we are able to communicate with the remote server
  const [loading, setLoading] = useState(false);
  const [hasReachedRemoteServer, setHasReachedRemoteServer] = useState(false);

  // Member - Determines whether the audio is muted
  const muted = window.START_MUTED ?? true;

  // Member - Saves a { url , title , extension , filename , playlist , metadataURL  } dictionary for every video
  // of the current playlist ( = all videos if no playlist, or a segment of it if any )
  const [videos, setVideos] = useState([]);
  const [currentVideoIndex, setCurrentVideoIndex] = useState(0);
  const [currentVideoMetadata, setCurrentVideoMetadata] = useState(false);
  const focusRequestRef = useRef(0);
  const previousVideoIndex = usePrevious(currentVideoIndex);
  const handleVideoFocus = useCallback((v, i) => {
    const focusRequest = ++focusRequestRef.current;

    // Update the browser tab's title
    _updatePageTitle(v);

    // Refresh internal state
    setCurrentVideoIndex(i);

    // Fetch metadata if any
    if (v && v.metadataURL) {
      return fetch(v.metadataURL, {
        method: "GET",
        headers: _makeHTTPHeaders(),
      })
        .then((r) => r.json())
        .then((r) => {
          if (focusRequest !== focusRequestRef.current) return;

          const playlistMetadata =
            _freshPlaylists.current.find((p) => p.name === v.playlist)
              ?.metadata || {};
          setCurrentVideoMetadata({
            channel_image: playlistMetadata.channel_image,
            channel_name: playlistMetadata.channel_name,
            ...r,
          });

          const titleField = v.type === "image" ? "image_title" : "video_title";
          if (r[titleField]) _updatePageTitle({ title: r[titleField] });
        });
    }
    // Retrieve metadata from the parent playlist if any
    else if (
      v &&
      _freshPlaylists.current.some(
        (p) => p.name === v.playlist && p.metadataURL,
      )
    ) {
      const _playlist = _freshPlaylists.current.find(
        (p) => p.name === v.playlist,
      );
      setCurrentVideoMetadata(_playlist.metadata);

      if (_playlist.metadata && _playlist.metadata.channel_title)
        _updatePageTitle({ title: _playlist.metadata.channel_title });
    } else {
      setCurrentVideoMetadata(false);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const handleVideoFinish = () => {
    if (!window.AUTOPLAY_ENABLED) return;
    document
      .querySelector(".feed")
      .scrollBy(
        _scrollDirection === "vertical"
          ? { top: 1, left: 0, behavior: "smooth" }
          : { top: 0, left: 1, behavior: "smooth" },
      );
  };

  // Member - Save playlists
  const [playlists, setPlaylists] = useState([]);
  const _playlistsMetadataLoaded = useRef(false);

  // An internal member used as a trick to get the latest playlists information
  // within the setCurrentVideoMetadata() callback
  const _freshPlaylists = useRef(playlists);
  useEffect(() => {
    _freshPlaylists.current = playlists;
  }, [playlists]);

  // Member - Whether the focused media is playing (a play icon is shown otherwise)
  const [isPlaying, setIsPlaying] = useState(true);

  // Method - Test connectivity with the remote server
  const attemptToReachRemoteServer = (evt) => {
    if (evt) evt.preventDefault();

    setLoading(true);

    if (evt) setHasEverSubmitted(true);

    fetch(`${window.PUBLIC_URL}/media/`, {
      method: "HEAD",
      cache: "no-cache",
      headers: _makeHTTPHeaders(),
    })
      .then((r) => {
        if (!r.ok) throw new Error();
        return r;
      })
      .then((r) => {
        if (window.USE_SECRET) {
          _storeSecret(formSecret);
          setSecureHash(r.headers.get("x-erin-hash"));
        }
        setHasReachedRemoteServer(true);
      })
      .catch((_) => {
        _clearStoredSecret();
        setHasReachedRemoteServer(false);
      })
      .finally((_) => {
        setLoading(false);
      });
  };

  // Method - Recursive video retrieval
  const _retrieveVideosRecursively = (path = "") => {
    return fetch(
      _toAuthenticatedUrl(
        `${window.PUBLIC_URL}/media/${encodeURIComponent(path)}`,
      ),
      {
        method: "GET",
        cache: "no-cache",
        headers: _makeHTTPHeaders(),
      },
    )
      .then((r) => r.json())
      .then(
        (files) =>
          new Promise((res, rej) => {
            if (!files) return res([]);

            let _folders = files.filter((f) => f.is_dir);
            let _files = files
              .filter((f) => !f.is_dir)
              .map((f) => ({ ...f, url: `${path}${f.url.slice(2).trim()}` }));

            if (window.IGNORE_HIDDEN_PATHS) {
              _folders = _folders.filter((f) => !f.name.startsWith("."));
              _files = _files.filter((f) => !f.name.startsWith("."));
            }

            const promises = _folders.map((f) =>
              _retrieveVideosRecursively(`${path}${f.name}`),
            );
            Promise.all(promises).then((results) => {
              res([...results.flat(), ..._files]);
            });
          }),
      )
      .catch((_) => new Promise((res, rej) => res([])));
  };

  // Method - Retrieve all the video links (and generate the associated playlists based on folder structure)
  const retrieveVideos = () => {
    setLoading(true);

    _retrieveVideosRecursively().then((files) => {
      if (!files) setLoading(false);

      // Put metadata files at the end to prevent misses while matching media.
      files.sort(
        (a, b) =>
          Number(a.name.toLowerCase().endsWith(".json")) -
          Number(b.name.toLowerCase().endsWith(".json")),
      );

      let _playlistsMetadataTracker = {};
      let _videoFiles = {};
      for (let i = 0; i < files.length; i++) {
        const current = files[i];
        const _filenameStem = current.name.split(".").slice(0, -1).join(".");
        const _id = current.url.split(".").slice(0, -1).join(".");

        if (!_filenameStem || current.is_dir) continue;

        // Case : Supported media file
        if (_isVideo(current) || _isImage(current)) {
          const type = _isImage(current) ? "image" : "video";
          const extension = current.name.toLowerCase().split(".").at(-1);
          if (type === "image" || !_isSafari || extension !== "ogg")
            _videoFiles[_id] = {
              type,
              url: window._decodeURIComponentSafe(
                _toAuthenticatedUrl(
                  `${window.PUBLIC_URL}/media/${current.url}`,
                ),
              ),
              filename: current.name,
              title: current.name
                .replaceAll("-", " ")
                .replaceAll("__", " - ")
                .split(".")
                .slice(0, -1)
                .join(""),
              extension,
              // playlist: current.url.replace(current.name, ""),
              playlist: current.url.substr(0, current.url.lastIndexOf("/")),
              metadataURL: false,
            };

          continue;
        }

        // Case : Metadata file for a media item
        if (_id in _videoFiles) {
          _videoFiles[_id].metadataURL = _toAuthenticatedUrl(
            `${window.PUBLIC_URL}/media/${current.url}`,
          );
          continue;
        }

        // Case : Metadata file for a playlist
        if (_filenameStem === "metadata") {
          const _name = current.url.substr(0, current.url.lastIndexOf("/"));
          _playlistsMetadataTracker[_name] = _toAuthenticatedUrl(
            `${window.PUBLIC_URL}/media/${current.url}`,
          );
        }
      }

      _videoFiles = Object.values(_videoFiles);
      // try {
      //   _storeVideos(_videoFiles);
      // } catch (_) {}

      // Playlist extraction
      const _allPlaylists = [
        ...new Set(_videoFiles.map((v) => v.playlist).filter((p) => p)),
      ].sort();
      setPlaylists(
        _allPlaylists.map((_p) => ({
          name: _p,
          metadataURL: _playlistsMetadataTracker[_p] || false,
        })),
      );

      // Filter video files retrieved according to the current url-defined playlist
      let currentPlaylist = window._decodeURIComponentSafe(
        window.location.pathname.substring(1),
      );
      if (currentPlaylist && currentPlaylist.substr(-1) === "/")
        currentPlaylist = currentPlaylist.substring(
          0,
          currentPlaylist.length - 1,
        );

      if (currentPlaylist)
        _videoFiles = _videoFiles.filter((v) => v.playlist === currentPlaylist);

      setVideos(_shuffleArray(_videoFiles));

      setLoading(false);
    });
  };

  // Memoized component - Video Feed
  const Feed = useMemo(
    () => {
      return (
        <VideoFeed
          initialIndex={
            currentVideoIndex > 0
              ? previousVideoIndex <= videos.length - 1 &&
                previousVideoIndex > 0
                ? currentVideoIndex - 2
                : currentVideoIndex - 1
              : 0
          }
          jumpToEnd={
            previousVideoIndex === videos.length && videos.length > 1
              ? true
              : false
          }
          jumpBackForward={
            previousVideoIndex !== videos.length && currentVideoIndex > 1
          }
          videos={videos}
          muted={muted}
          onFocusVideo={handleVideoFocus}
          onFinishVideo={handleVideoFinish}
          onPlaybackStateChange={setIsPlaying}
        />
      );
    },
    [videos, muted], // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Hook - On mount
  // - Retrieve the locally-stored secret
  // - Attempt to hide the address bar
  // - Retrieve the cache if any
  // - Load the custom stylesheet if configured
  useEffect(() => {
    window.onload = () => {
      setTimeout(() => {
        window.scrollTo(0, 1);
      }, 0);
    };

    if (window.USE_CUSTOM_SKIN) _injectCustomStylesheet();

    _updatePageTitle();

    if (!window.USE_SECRET) {
      setAutoconnect(true);
      return;
    }

    const storedSecret = localStorage.getItem("erin_secret");

    if (!storedSecret || storedSecret.length === 0) return;

    setFormSecret(storedSecret);
    setAutoconnect(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Hook - When locally-stored secret was retrieved - Auto-connect to the remote server
  useEffect(() => {
    if (!autoconnect) return;

    attemptToReachRemoteServer();
  }, [autoconnect]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hook - When the remote server was reached and the user was authenticated - Retrieve the videos
  useEffect(() => {
    if (!hasReachedRemoteServer) return;

    retrieveVideos();
  }, [secureHash, hasReachedRemoteServer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hook - When the playlists are loaded
  // - Load all their metadata via async HTTP calls
  useEffect(() => {
    if (!playlists || playlists.length === 0) return;

    if (_playlistsMetadataLoaded.current) return;

    Promise.all(
      playlists.map((p) =>
        !p.metadataURL
          ? new Promise((res, rej) => res(p))
          : fetch(p.metadataURL, { method: "GET", headers: _makeHTTPHeaders() })
              .then((r) => r.json())
              .then((r) => ({ ...p, metadata: r })),
      ),
    ).then((results) => {
      _playlistsMetadataLoaded.current = true;
      setPlaylists(results);

      // Force-refresh the video metadata after the playlists' metadata were loaded
      setTimeout(() => {
        handleVideoFocus(videos[currentVideoIndex], currentVideoIndex);
      }, 0);
    });
  }, [playlists]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="screen">
      <div className="container">
        {/* STATE - Loading */}
        {loading && (
          <div className="loading-state">
            <FontAwesomeIcon icon={faCompactDisc} />
          </div>
        )}

        {!loading && (
          <>
            {/* STATE - Hasn't reached remote server */}
            {!hasReachedRemoteServer && (
              <>
                {window.USE_SECRET && (
                  <div className="login-state">
                    <div className="icon-wrapper">
                      <img src={`/logo.png`} alt="Erin logo" />
                    </div>
                    <h1>Welcome to Erin</h1>
                    <p>Let's connect and browse your media</p>
                    <form onSubmit={attemptToReachRemoteServer}>
                      <label htmlFor="password">Your password</label>
                      <input
                        id="password"
                        name="password"
                        type="password"
                        placeholder="Please fill in your secure password"
                        onInput={handleInputSecret}
                      />
                      <button type="submit">Connect</button>
                      {hasEverSubmitted && (
                        <p className="form-error">Wrong password</p>
                      )}
                    </form>
                  </div>
                )}
              </>
            )}

            {/* STATE - Reached remote server but no media was found */}
            {hasReachedRemoteServer && videos.length === 0 && (
              <div className="empty-state">
                <div className="icon-wrapper">
                  <img src={`/logo.png`} alt="Erin logo" />
                </div>
                <h1>Nothing to watch</h1>
                <p>No media was found on your remote server</p>
                <button type="button" onClick={_reloadPage}>
                  Refresh
                </button>
              </div>
            )}

            {/* STATE - Reached remote server and retrieved media */}
            {hasReachedRemoteServer && videos.length > 0 && (
              <>
                {Feed}
                {videos[currentVideoIndex] && (
                  <BottomMetadata
                    video={videos[currentVideoIndex]}
                    extraMetadata={currentVideoMetadata}
                  />
                )}
                {!isPlaying && (
                  <div className="paused-indicator">
                    <FontAwesomeIcon icon={faPlay} />
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default App;
