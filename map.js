'use strict';

/* ==========================================================================
   Shared course map.

   Plain inline SVG: no tile layer, no dependency, no network call. It draws on
   the back nine with no signal, which is the whole point. Every colour comes
   from a CSS variable (see map.css), so the map follows light and dark mode
   with no JavaScript involved.

   Two pages use it:
   - index.html             the Yardage tab, showing the hole you are standing on
   - tools/map-course.html  the mapper, showing the walk as it is recorded

   Keep it framework-free and readable. Whoever inherits this project may never
   have used a build tool.
   ========================================================================== */

var GolfMap = (function () {
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var PAD = 26;              // SVG units kept clear around the drawing
  var M_PER_YD = 0.9144;
  var OFF_MAP_M = 800;       // past this, a fix is not on the mapped course
  var POINT_ORDER = ['tee', 'front', 'center', 'back'];
  var GREEN_POINTS = ['front', 'center', 'back'];
  var SCALE_STEPS = [1000, 500, 200, 100, 50, 25, 10];

  function el(name, attrs, text) {
    var n = document.createElementNS(SVG_NS, name);
    Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  /** Read the drawing box off the element, so each page picks its own shape. */
  function viewBox(svg) {
    var raw = svg.getAttribute('viewBox');
    var p = raw ? raw.trim().split(/[\s,]+/).map(Number) : [];
    return (p.length === 4 && p[2] > 0 && p[3] > 0)
      ? { w: p[2], h: p[3] }
      : { w: 400, h: 320 };
  }

  /** Flat metres between two coordinates. Accurate enough over a course, and
      it keeps this file independent of app.js. */
  function metres(a, b) {
    var dx = (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180);
    var dy = (b.lat - a.lat) * 110540;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function holeCoords(holes) {
    var out = [];
    holes.forEach(function (h) {
      POINT_ORDER.forEach(function (name) {
        var pt = h && h[name];
        if (pt && pt.lat != null && pt.lon != null) out.push(pt);
      });
      // The bend of a dogleg is part of the hole's extent. Leave it out and a
      // hole that swings wide draws its corner off the edge of the frame. The
      // same goes for a bunker sitting past the back of the green.
      (h && h.path ? h.path : []).forEach(function (pt) {
        if (pt && pt.lat != null && pt.lon != null) out.push(pt);
      });
      (h && h.bunkers ? h.bunkers : []).forEach(function (ring) {
        (ring || []).forEach(function (pt) {
          if (pt && pt.lat != null && pt.lon != null) out.push(pt);
        });
      });
    });
    return out;
  }

  /** Equirectangular projection, fitted to the SVG box, optionally turned by
      `rot` radians so some other direction than north points up. Over a
      course-sized area the distortion is far below GPS noise, so it needs
      nothing fancier. */
  function makeProjection(all, w, h, rot) {
    var lat0 = all.reduce(function (s, p) { return s + p.lat; }, 0) / all.length;
    var mPerLon = 111320 * Math.cos((lat0 * Math.PI) / 180);
    var mPerLat = 110540;

    // Rotation is linear, so turning first and measuring after gives a box
    // fitted to the turned drawing rather than to its north-up shadow.
    var cos = Math.cos(rot || 0), sin = Math.sin(rot || 0);
    var turn = function (p) {
      var x = p.lon * mPerLon, y = p.lat * mPerLat;
      return [x * cos - y * sin, x * sin + y * cos];
    };

    var xs = all.map(function (p) { return turn(p)[0]; });
    var ys = all.map(function (p) { return turn(p)[1]; });
    var minX = Math.min.apply(null, xs), maxX = Math.max.apply(null, xs);
    var minY = Math.min.apply(null, ys), maxY = Math.max.apply(null, ys);

    // With one or two points the extent is near zero; clamp so the view does
    // not zoom to absurdity before the walk has got going.
    var spanX = Math.max(maxX - minX, 60);
    var spanY = Math.max(maxY - minY, 60);
    var cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

    var scale = Math.min((w - 2 * PAD) / spanX, (h - 2 * PAD) / spanY);

    return {
      scale: scale,                              // SVG units per metre
      xy: function (p) {
        var t = turn(p);
        return [
          w / 2 + (t[0] - cx) * scale,
          h / 2 - (t[1] - cy) * scale             // SVG y grows downward
        ];
      }
    };
  }

  /** The angle that puts `from`-to-`to` on the screen's up axis. */
  function playAngle(from, to) {
    var mPerLon = 111320 * Math.cos((from.lat * Math.PI) / 180);
    var dx = (to.lon - from.lon) * mPerLon;
    var dy = (to.lat - from.lat) * 110540;
    return (dx || dy) ? Math.atan2(dx, dy) : 0;
  }

  /** A needle, so a map turned down the fairway still says where north is. */
  function drawNorth(svg, rot, w) {
    var x = w - 20, y = 20, len = 9;
    var dx = -Math.sin(rot) * len, dy = -Math.cos(rot) * len;
    svg.appendChild(el('line',
      { class: 'north', x1: x - dx, y1: y - dy, x2: x + dx, y2: y + dy }));
    svg.appendChild(el('circle', { class: 'north-tip', cx: x + dx, cy: y + dy, r: 2.5 }));
    svg.appendChild(el('text',
      { class: 'scale-txt', x: x - 14, y: y + 4, 'text-anchor': 'end' }, 'N'));
  }

  /** A bar to measure yardages against. Picks the longest round number that
      still fits, so it reads whether zoomed to one hole or pulled back over
      eighteen. */
  function drawScaleBar(svg, scale, w, h) {
    var room = (w - 2 * PAD) * 0.55;
    var yards = 0, px = 0;

    for (var i = 0; i < SCALE_STEPS.length; i++) {
      px = SCALE_STEPS[i] * M_PER_YD * scale;
      if (px <= room) { yards = SCALE_STEPS[i]; break; }
    }
    if (!yards || px < 20) return;

    var x = PAD / 2, y = h - 12;
    svg.appendChild(el('line', { class: 'scale', x1: x, y1: y, x2: x + px, y2: y }));
    svg.appendChild(el('line', { class: 'scale', x1: x, y1: y - 4, x2: x, y2: y + 4 }));
    svg.appendChild(el('line', { class: 'scale', x1: x + px, y1: y - 4, x2: x + px, y2: y + 4 }));
    svg.appendChild(el('text', { class: 'scale-txt', x: x, y: y - 8 }, yards + ' yds'));
  }

  /** Turn the mapper's flat records - {hole, point, lat, lon} - into the hole
      shape data/course.json uses, which is what render() draws. */
  function groupByHole(points) {
    var byHole = {};
    (points || []).forEach(function (p) {
      var h = byHole[p.hole] || (byHole[p.hole] = { hole: p.hole });
      h[p.point] = p;
    });
    return Object.keys(byHole)
      .map(Number)
      .sort(function (a, b) { return a - b; })
      .map(function (k) { return byHole[k]; });
  }

  /**
   * Draw into an <svg class="map"> element.
   *
   * opts.holes      holes to draw, in data/course.json shape
   * opts.me         {lat, lon, accuracy} - accuracy in metres, drawn to scale
   * opts.highlight  {lat, lon} ringed for emphasis (the point just recorded)
   * opts.labels     'hole' (number by each tee), 'detail' (Tee / Green), 'none'
   * opts.rotate     'play' turns the map so the tee shot points up the screen
   * opts.aim        draw the line from you to the green you are playing to
   * opts.pick       add a tap target over each hole number, tagged data-hole
   * opts.watermark  faint text across the map, for layouts that are not real
   * opts.empty      text shown when there is nothing to draw
   *
   * Returns {drawn, meOffMap} so the caller can explain what it is showing.
   */
  function render(svg, opts) {
    opts = opts || {};
    var box = viewBox(svg);
    var holes = (opts.holes || []).filter(Boolean);
    var me = opts.me && opts.me.lat != null ? opts.me : null;

    while (svg.firstChild) svg.removeChild(svg.firstChild);
    svg.classList.toggle('example', !!opts.watermark);

    var fixed = holeCoords(holes);
    if (!fixed.length && !me) {
      if (opts.empty) {
        svg.appendChild(el('text', {
          x: box.w / 2, y: box.h / 2, 'text-anchor': 'middle', class: 'empty-txt'
        }, opts.empty));
      }
      return { drawn: false, meOffMap: false };
    }

    // A fix hundreds of miles out - a desktop browser guessing from the
    // network, or an away match on an unmapped course - would squash the
    // course to a dot. Leave it out of the extent and let the caller say so.
    var offMap = false;
    if (me && fixed.length) {
      var nearest = fixed.reduce(function (best, p) {
        var d = metres(me, p);
        return best == null || d < best ? d : best;
      }, null);
      offMap = nearest > OFF_MAP_M;
    }

    // Facing down the fairway is how a hole is read on the tee, and it fills
    // the frame whichever way the hole happens to run.
    var rot = 0;
    if (opts.rotate === 'play' && holes.length === 1) {
      var one = holes[0];
      // Face the way the tee shot is hit, which on a dogleg is the corner
      // rather than the green. Lining up on the green instead turns the hole
      // sideways in the frame and hides the bend that makes it that hole.
      var aimPt = (one.path && one.path.length > 1)
        ? one.path[1]
        : (one.center || one.front || one.back);
      if (one.tee && aimPt) rot = playAngle(one.tee, aimPt);
    }

    // Tap targets are collected as the holes are drawn and appended last, so
    // nothing drawn afterwards — the "you" dot, the scale bar — can sit over
    // one and swallow the tap.
    var hits = [];

    var all = fixed.slice();
    if (me && !offMap) all.push(me);
    var proj = makeProjection(all, box.w, box.h, rot);

    // Drawn first so it sits behind the routing.
    if (opts.watermark) {
      svg.appendChild(el('text', {
        class: 'watermark', x: box.w / 2, y: box.h / 2, 'text-anchor': 'middle',
        transform: 'rotate(-18 ' + box.w / 2 + ' ' + box.h / 2 + ')'
      }, opts.watermark));
    }

    holes.forEach(function (h) {
      var target = h.center || h.front || h.back;

      // The route the hole actually takes. With a 'path' this is the real
      // centre-line, doglegs and all — which is the only thing that makes one
      // hole on this map look different from the next. Without one it falls
      // back to a straight tee-to-green line.
      var route = (h.path && h.path.length > 1)
        ? h.path.slice()
        : (h.tee && target ? [h.tee, target] : null);

      if (route) {
        // Run the line all the way to the pin: the mapped centre-line usually
        // stops at the front edge, and a route that halts short of the green
        // reads as though the hole does.
        if (target) route.push(target);
        var pts = route.map(function (p) { return proj.xy(p).join(','); }).join(' ');

        // A soft band under the line, so the shape of the hole reads at a
        // glance instead of having to be traced. Only on a single hole: at
        // whole-course scale eighteen bands overlap into a smear, and only
        // with a real centre-line, since a band drawn straight tee-to-green
        // would be claiming corridor the data does not have.
        if (holes.length === 1 && h.path && h.path.length > 1) {
          svg.appendChild(el('polyline', { class: 'fairway', points: pts }));
        }

        // Sand on top of the corridor it sits in, under the line of play so
        // the route still reads across it. Single hole only: a hundred and
        // twenty bunkers at whole-course scale is a texture, not information.
        if (holes.length === 1 && h.bunkers) {
          h.bunkers.forEach(function (ring) {
            if (!ring || ring.length < 3) return;
            svg.appendChild(el('polygon', {
              class: 'bunker',
              points: ring.map(function (p) { return proj.xy(p).join(','); }).join(' ')
            }));
          });
        }

        svg.appendChild(el('polyline', { class: 'play', points: pts }));
      }

      // The green itself, drawn front-to-back so its depth and angle show.
      if (h.front && h.back) {
        var f = proj.xy(h.front), bk = proj.xy(h.back);
        svg.appendChild(el('line', { class: 'green', x1: f[0], y1: f[1], x2: bk[0], y2: bk[1] }));
      }

      GREEN_POINTS.forEach(function (name) {
        if (!h[name]) return;
        var c = proj.xy(h[name]);
        svg.appendChild(el('circle', {
          class: 'pin', cx: c[0], cy: c[1], r: name === 'center' ? 4 : 2.5
        }));
      });

      if (h.tee) {
        var t = proj.xy(h.tee);
        svg.appendChild(el('circle', { class: 'tee', cx: t[0], cy: t[1], r: 5 }));
        if (opts.labels === 'hole' && h.hole != null) {
          svg.appendChild(el('text',
            { class: 'label', x: t[0] + 9, y: t[1] + 4 }, String(h.hole)));

          // An 11px numeral is not something a thumb can hit. This disc covers
          // the tee and its number together and is what actually gets tapped;
          // what a tap means is the caller's business, not the map's.
          if (opts.pick) {
            hits.push(el('circle', {
              'class': 'hole-hit', 'data-hole': String(h.hole),
              cx: t[0] + 5, cy: t[1], r: 18
            }));
          }
        } else if (opts.labels === 'detail') {
          svg.appendChild(el('text',
            { class: 'label', x: t[0] + 9, y: t[1] + 4 }, 'Tee'));
        }
      }

      if (opts.labels === 'detail' && target) {
        var g = proj.xy(target);
        svg.appendChild(el('text',
          { class: 'label', x: g[0] + 9, y: g[1] + 4 }, 'Green'));
      }
    });

    // Ring a point for emphasis - in the mapper, the one just recorded.
    if (opts.highlight && opts.highlight.lat != null) {
      var hl = proj.xy(opts.highlight);
      svg.appendChild(el('circle', { class: 'latest', cx: hl[0], cy: hl[1], r: 10 }));
    }

    if (me && !offMap) {
      var m = proj.xy(me);

      // Where you are aiming. Drawn before the dot so the dot stays on top.
      if (opts.aim && holes.length === 1) {
        var aimAt = holes[0].center || holes[0].front || holes[0].back;
        if (aimAt) {
          var ga = proj.xy(aimAt);
          svg.appendChild(el('line',
            { class: 'aim', x1: m[0], y1: m[1], x2: ga[0], y2: ga[1] }));
        }
      }

      // Accuracy drawn to scale: a big ring means a weak fix and a soft
      // number. Clamped so a 2 km desktop "fix" cannot swallow the map.
      if (opts.me.accuracy != null) {
        var r = Math.min(opts.me.accuracy * proj.scale, Math.min(box.w, box.h) * 0.45);
        svg.appendChild(el('circle',
          { class: 'me-ring', cx: m[0], cy: m[1], r: Math.max(7, r) }));
      }
      svg.appendChild(el('circle', { class: 'me', cx: m[0], cy: m[1], r: 5 }));
    }

    hits.forEach(function (n) { svg.appendChild(n); });

    drawScaleBar(svg, proj.scale, box.w, box.h);
    if (rot) drawNorth(svg, rot, box.w);
    return { drawn: true, meOffMap: offMap };
  }

  return { render: render, groupByHole: groupByHole };
})();
