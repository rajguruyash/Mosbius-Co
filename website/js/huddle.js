/* Mosbius & Co: the Huddle section's video.
 *
 * The video plays while it is on screen and stops when it scrolls away, as the page's scenes do. A visitor who asked
 * for reduced motion gets the still picture and a play button instead. Without this script the video still works:
 * it carries its own controls, and this script swaps them for one button.
 */
(function (M) {
  'use strict';

  const reduced = () => (M && M.reducedMotion ? M.reducedMotion() : false);

  function setup(video) {
    const figure = video.closest('figure');
    if (!figure) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn-primary huddle-play';
    button.setAttribute('aria-pressed', 'false');
    const label = () => {
      button.textContent = video.paused ? 'Play the video' : 'Pause the video';
      button.setAttribute('aria-pressed', String(!video.paused));
    };

    // true while the visitor has not paused it on purpose; scrolling away and back never overrides a pause they chose
    let wanted = !reduced();
    const play = () => {
      const p = video.play();
      if (p && p.catch) p.catch(() => { /* the browser said not now: the button is there */ });
    };

    button.addEventListener('click', () => {
      wanted = video.paused;
      if (wanted) play(); else video.pause();
    });
    video.addEventListener('play', label);
    video.addEventListener('pause', label);

    video.removeAttribute('controls');
    figure.insertBefore(button, figure.querySelector('figcaption'));
    label();

    if ('IntersectionObserver' in window) {
      new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (e.isIntersecting && wanted) { video.preload = 'auto'; play(); }
          else if (!e.isIntersecting) video.pause();
        }
      }, { threshold: 0.35 }).observe(video);
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('video[data-huddle-video]').forEach(setup);
  });
})(window.M);
