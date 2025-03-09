document.addEventListener('DOMContentLoaded', async function() {
  // Detect mobile screen width (adjust threshold as needed)
  const isMobile = window.innerWidth < 1068;

  // Initialize the map with the same zoom for both but larger tiles on mobile
  var map = L.map('map', {
    zoomControl: false,
    maxZoom: 22
  }).setView([40.7128, -74.0060], 16);

  // Add Carto Positron tile layer
  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    tileSize: isMobile ? 512 : 256,
    zoomOffset: isMobile ? -1 : 0,
    maxZoom: 22,
  }).addTo(map);

  // Predefined mapping for line colors
  const lineColors = {
    "A": "#0039A6",
    "C": "#0039A6",
    "E": "#0039A6",
    "G": "#6CBE45",
    "B": "#FF6319",
    "D": "#FF6319",
    "F": "#FF6319",
    "M": "#FF6319",
    "J": "#996633",
    "Z": "#996633",
    "N": "#FCCC0A",
    "Q": "#FCCC0A",
    "R": "#FCCC0A",
    "W": "#FCCC0A",
    "L": "#A7A9AC",
    "1": "#EE352E",
    "2": "#EE352E",
    "3": "#EE352E",
    "4": "#00933C",
    "5": "#00933C",
    "6": "#00933C",
    "7": "#B933AD",
    "SI": "#6CBE45"
  };

  // Global objects to store stops data, markers, and arrival times
  let stopsMap = {};    // from stops.txt: { stop_id: { lat, lon, name, parent_station } }
  let feedTimes = {};   // feedTimes[stopId] = { "A": [arrivalEpoch, ...], ... }

  // Global dictionary to keep station markers so we update rather than recreate them.
  let markerMap = {};   // keys: stopId => marker instance

  // Use a featureGroup for train markers so we can call bringToFront()
  let trainMarkersLayer = L.featureGroup().addTo(map);
  // Global dictionary for train markers keyed by tripId
  let trainMarkers = {};
  // Global set to hold current train IDs during feed update.
  let currentTrainIds = new Set();

  // Global variable to track the last clicked station id (the "came from" station)
  let lastClickedStationId = null;
  // Global variable to track the currently highlighted marker
  let highlightedMarker = null;
  // Declare popupTimer only once globally
  let popupTimer = null;

  // Global current time (in seconds) updated every second.
  let currentTimeSec = Date.now() / 1000;
  setInterval(() => { currentTimeSec = Date.now() / 1000; }, 1000);

  // Helper: returns the first upcoming train time (as a local time string) for a given station id.
  function getFirstTrainTime(stopId) {
    if (!feedTimes[stopId]) return null;
    let minEpoch = Infinity;
    Object.keys(feedTimes[stopId]).forEach(line => {
      feedTimes[stopId][line].forEach(epoch => {
        const t = epoch * 1000;
        if (t > Date.now() && t < minEpoch) {
          minEpoch = t;
        }
      });
    });
    return minEpoch === Infinity ? null : new Date(minEpoch).toLocaleTimeString();
  }
  window.getFirstTrainTime = getFirstTrainTime;

  // Helper: linear interpolation between two coordinates ([lat, lon])
  function interpolateCoords(coord1, coord2, fraction) {
    const lat = coord1[0] + (coord2[0] - coord1[0]) * fraction;
    const lon = coord1[1] + (coord2[1] - coord1[1]) * fraction;
    return [lat, lon];
  }

  // Helper functions for time formatting
  function formatTimeComponents(deltaSec) {
    const minutes = Math.floor(deltaSec / 60);
    const seconds = Math.floor(deltaSec % 60);
    return { minutes, seconds };
  }

  function formatTimeString(deltaSec) {
    const isPast = deltaSec < 0;
    // Use the absolute value to compute minutes and seconds
    const { minutes, seconds } = formatTimeComponents(Math.abs(deltaSec));
    // Prepend the negative sign to minutes if needed
    const minutesStr = isPast ? "-" + minutes : minutes;
    return `${minutesStr} min ${seconds < 10 ? "0" + seconds : seconds} sec`;
  }
  
  // Helper: returns a formatted remaining time string.
  function getRemainingTime(arrivalTime) {
    const diff = arrivalTime - currentTimeSec;
    return formatTimeString(diff);
  }
  
  // Function to parse CSV data from stops.txt
  function parseStopsCsv(csvString) {
    const lines = csvString.trim().split('\n');
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(',');
      const stop_id = row[0];
      const stop_name = row[1];
      const stop_lat = parseFloat(row[2]);
      const stop_lon = parseFloat(row[3]);
      const parent_station = row[5] || "";
      stopsMap[stop_id] = { lat: stop_lat, lon: stop_lon, name: stop_name, parent_station };
    }
  }

  // Load stops.txt and parse it
  async function loadStops() {
    try {
      const response = await fetch('stops.txt');
      if (!response.ok) throw new Error(`Failed to load stops.txt: ${response.status}`);
      const csvData = await response.text();
      parseStopsCsv(csvData);
      console.log("Stops loaded:", stopsMap);
    } catch (error) {
      console.error("Error loading stops.txt:", error);
    }
  }

  // Helper: compute a scale factor based on current zoom level.
  function getScaleForZoom(zoom) {
    const baseZoom = 15;
    const factorPerZoom = 0.4;
    return Math.max(0.2, 1 + (zoom - baseZoom) * factorPerZoom);
  }

  function createSvgIcon(stopId, lines, scale = 1, highlight = false) {
    let svgHTML = "";
    let iconSize = [0, 0];
    // Multiply the scale factor if this icon is highlighted (clicked)
    if (highlight) {
      scale = scale * 1.5;
    }
    if (lines && lines.size > 0) {
      const linesArray = Array.from(lines).sort();
      const count = linesArray.length;
      if (scale < 1.5) {
        const color = lineColors[linesArray[0]] || "#000000";
        const baseRadius = 12;
        const baseStrokeWidth = 4;
        const radius = baseRadius * scale;
        const strokeWidth = baseStrokeWidth * scale;
        const diameter = radius * 2;
        const margin = strokeWidth * 3;
        const svgWidth = diameter + 2 * margin;
        const svgHeight = diameter + 2 * margin;
        const cx = svgWidth / 2;
        const cy = svgHeight / 2;
        svgHTML = `
          <svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg" style="overflow: visible;">
            <circle cx="${cx}" cy="${cy}" r="${radius}" fill="white" stroke="${color}" stroke-width="${strokeWidth}"></circle>
          </svg>
        `;
        iconSize = [svgWidth, svgHeight];
      } else {
        const baseRadius = 12;
        const baseSpacing = 4;
        const baseFontSize = 14;
        const baseStrokeWidth = 4;
        const radius = baseRadius * scale;
        const diameter = radius * 2;
        const spacing = baseSpacing * scale;
        const fontSize = baseFontSize * scale;
        const strokeWidth = baseStrokeWidth * scale;
        const svgWidth = count * diameter + (count - 1) * spacing;
        const svgHeight = diameter;
        let circlesSVG = "";
        for (let i = 0; i < count; i++) {
          const lineLetter = linesArray[i];
          const color = lineColors[lineLetter] || "#000000";
          const cx = i * (diameter + spacing) + radius;
          const cy = radius;
          circlesSVG += `
            <circle cx="${cx}" cy="${cy}" r="${radius}" fill="white" stroke="${color}" stroke-width="${strokeWidth}"></circle>
            <text x="${cx}" y="${cy}" text-anchor="middle" alignment-baseline="middle" dominant-baseline="middle" fill="${color}" font-size="${fontSize}" font-family="Arial, sans-serif" font-weight="bold">
              ${lineLetter}
            </text>
          `;
        }
        svgHTML = `
          <svg width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}" xmlns="http://www.w3.org/2000/svg" style="overflow: visible;">
            ${circlesSVG}
          </svg>
        `;
        iconSize = [svgWidth, svgHeight];
      }
    }
    return L.divIcon({
      html: svgHTML,
      className: "custom-svg-icon",
      iconSize: iconSize,
      iconAnchor: [iconSize[0] / 2, iconSize[1] / 2],
      popupAnchor: [0, -iconSize[1] / 2]
    });
  }
  

// Function to format time difference in detailed format.
function formatTimeDetailed(deltaMillis) {
  const isPast = deltaMillis < 0;
  const absDelta = Math.abs(deltaMillis);
  const totalSeconds = Math.floor(absDelta / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  
  // Use sign only for the minutes portion
  const sign = isPast ? "-" : "";
  let formatted = "";
  if (hours > 0) {
    formatted = hours + " hrs " + sign + minutes + " min";
  } else {
    if (minutes < 5) {
      formatted = sign + minutes + " min " + (seconds < 10 ? "0" + seconds : seconds) + " sec";
    } else {
      formatted = sign + minutes + " min";
    }
  }
  return formatted;
}


  // Function to build the popup table content.
  function buildPopupTable(stopId, linesSet) {
    const linesArray = Array.from(linesSet).sort();
    let columnsHTML = `<div style="display:flex; gap:10px;">`;
    linesArray.forEach(line => {
      const color = lineColors[line] || "#000000";
      let headerSVG = `
        <svg width="70" height="70" viewBox="0 0 24 24" style="vertical-align:middle;">
          <circle cx="12" cy="12" r="10" fill="white" stroke="${color}" stroke-width="3"></circle>
          <text x="12" y="16" text-anchor="middle" fill="${color}" font-size="14" font-weight="bold" font-family="Arial">${line}</text>
        </svg>
      `;
      let arrivalsHTML = "";
      if (feedTimes[stopId] && feedTimes[stopId][line]) {
        let times = feedTimes[stopId][line].slice().sort((a, b) => a - b);
        times = times.slice(0, 4);
        times.forEach(arrivalEpoch => {
          const diff = arrivalEpoch - currentTimeSec;
          if (diff < -300) return;
          const formatted = formatTimeString(diff);
          const style = diff < 0 
            ? `background: #dadada; color:red; padding:10px; margin:8px; border-radius:20px; font-size:0.8em;`
            : `background:${color}; color:#fff; padding:10px; margin:8px; border-radius:20px; font-size:0.8em;`;
          arrivalsHTML += `<div style="${style}">${formatted}</div>`;
        });
      } else {
        arrivalsHTML = `<div style="padding:5px; margin-top:5px; font-size:0.8em;">--</div>`;
      }
      columnsHTML += `<div style="flex:1; text-align:center;">${headerSVG}${arrivalsHTML}</div>`;
    });
    columnsHTML += `</div>`;
    return columnsHTML;
  }

  // Function to display the fixed popup.
  function showFixedPopup(stopId, name, linesSet, borderColor) {
    let popupEl = document.getElementById('fixed-popup');
    if (!popupEl) {
      popupEl = document.createElement('div');
      popupEl.id = 'fixed-popup';
      document.body.appendChild(popupEl);
    }
    const titleHTML = `<div class="popup-title" style="margin-bottom:10px; font-size:1.2em;"><strong>${name}</strong></div>`;
    const tableHTML = `<div id="popup-table">${buildPopupTable(stopId, linesSet)}</div>`;
    const content = titleHTML + tableHTML;
    window.currentPopupStopId = stopId;
    window.currentPopupLines = linesSet;
    popupEl.innerHTML = content + `<div class="close-btn" onclick="document.getElementById('fixed-popup').style.display='none'; clearInterval(popupTimer);"></div>`;
    popupEl.style.borderColor = borderColor;
    popupEl.style.display = 'block';

    if (popupTimer) clearInterval(popupTimer);
    popupTimer = setInterval(() => {
      if (window.currentPopupStopId && window.currentPopupLines) {
        const newTableHTML = buildPopupTable(window.currentPopupStopId, window.currentPopupLines);
        const tableEl = document.getElementById('popup-table');
        if (tableEl) {
          tableEl.innerHTML = newTableHTML;
        }
      }
    }, 1000);
  }

  // Function to hide the fixed popup.
  function hideFixedPopup() {
    const popupEl = document.getElementById('fixed-popup');
    if (popupEl) {
      popupEl.style.display = 'none';
    }
    if (popupTimer) {
      clearInterval(popupTimer);
      popupTimer = null;
    }
  }

  window.getFirstTrainTime = getFirstTrainTime;

  // --- Global dictionary for route polylines and array for polyline layers ---
  let routeLines = {};
  let polylineLayers = [];

  // Helper: Calculate polyline weight based on zoom level.
  function getPolylineWeight(zoom) {
    const minZoom = 12, maxZoom = 22;
    const minWeight = 3, maxWeight = 5;
    if (zoom <= minZoom) return minWeight;
    if (zoom >= maxZoom) return maxWeight;
    return minWeight + ((zoom - minZoom) / (maxZoom - minZoom)) * (maxWeight - minWeight);
  }

  // Helper: Calculate train marker radius based on zoom level.
  function getTrainMarkerRadius(zoom) {
    const minZoom = 14, maxZoom = 22;
    const minRadius = 6, maxRadius = 15;
    if (zoom <= minZoom) return minRadius;
    if (zoom >= maxZoom) return maxRadius;
    return minRadius + ((zoom - minZoom) / (maxZoom - minZoom)) * (maxRadius - minRadius);
  }

  // Load and add the NYC_Line GeoJSON, storing each polyline layer.
  fetch('NYC_Line.geojson')
    .then(response => response.json())
    .then(data => {
      const offsetFeatures = data.features.map(feature => {
        const routeId = feature.properties.route_id;
        let offsetDistance = 0;
        if (!isNaN(parseFloat(routeId))) {
          offsetDistance = 0.00005 * (parseInt(routeId) - 1);
        }
        if (feature.geometry.type === "LineString") {
          const offsetLine = turf.lineOffset(feature, offsetDistance, { units: 'degrees' });
          offsetLine.properties = feature.properties;
          routeLines[routeId] = offsetLine;
          return offsetLine;
        }
        return feature;
      });
      const offsetGeoJson = { type: "FeatureCollection", features: offsetFeatures };
      L.geoJSON(offsetGeoJson, {
        style: function(feature) {
          const routeId = feature.properties.route_id;
          return {
            color: lineColors[routeId] || "#000000",
            weight: getPolylineWeight(map.getZoom()),
            opacity: 0.8
          };
        },
        onEachFeature: function(feature, layer) {
          polylineLayers.push(layer);
        }
      }).addTo(map);
    })
    .catch(err => console.error("Error loading GeoJSON:", err));

  // Function to fetch and process realtime feeds.
  async function updateFeed() {
    try {
      const endpoints = [
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-ace',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-g',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-bdfm',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-jz',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-nqrw',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-l',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs',
        'https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/nyct%2Fgtfs-si'
      ];
      const root = await protobuf.load("gtfs-realtime.proto");
      const FeedMessage = root.lookupType("transit_realtime.FeedMessage");
      const feedPromises = endpoints.map(async endpoint => {
        try {
          const response = await fetch(endpoint);
          if (!response.ok) {
            console.error(`Feed fetch failed for ${endpoint} with status ${response.status}`);
            return null;
          }
          const buffer = await response.arrayBuffer();
          const message = FeedMessage.decode(new Uint8Array(buffer));
          return FeedMessage.toObject(message, {
            enums: String,
            longs: String,
            defaults: true,
          });
        } catch (e) {
          console.error(`Error processing ${endpoint}:`, e);
          return null;
        }
      });
      const feeds = await Promise.all(feedPromises);
      let combinedEntities = [];
      feeds.forEach(feed => {
        if (feed && feed.entity) {
          combinedEntities = combinedEntities.concat(feed.entity);
        }
      });
      console.log("Combined feed entities count:", combinedEntities.length);
      let feedStops = {};
      feedTimes = {};
      combinedEntities.forEach(entity => {
        if (entity.tripUpdate && entity.tripUpdate.stopTimeUpdate) {
          let line = String(entity.tripUpdate.trip && entity.tripUpdate.trip.routeId || "Unknown")
                      .trim().toUpperCase().replace(/\s+/g, "");
          entity.tripUpdate.stopTimeUpdate.forEach(stu => {
            if (stu.stopId) {
              if (!feedStops[stu.stopId]) feedStops[stu.stopId] = new Set();
              feedStops[stu.stopId].add(line);
              if (stu.arrival && stu.arrival.time) {
                const arrivalEpoch = parseInt(stu.arrival.time);
                if (!feedTimes[stu.stopId]) feedTimes[stu.stopId] = {};
                if (!feedTimes[stu.stopId][line]) feedTimes[stu.stopId][line] = [];
                feedTimes[stu.stopId][line].push(arrivalEpoch);
              }
            }
          });
        } else if (entity.vehicle && entity.vehicle.stopId) {
          let line = String(entity.vehicle.trip && entity.vehicle.trip.routeId || "Unknown")
                      .trim().toUpperCase().replace(/\s+/g, "");
          const stopId = entity.vehicle.stopId;
          if (!feedStops[stopId]) feedStops[stopId] = new Set();
          feedStops[stopId].add(line);
        }
      });
      console.log("Combined realtime lines by stop:", feedStops);
      console.log("Feed times by stop:", feedTimes);

      // Update station markers if zoom >= 15.
      const currentZoom = map.getZoom();
      if (currentZoom >= 15) {
        Object.keys(feedStops).forEach(stopId => {
          if (stopsMap[stopId]) {
            const { lat, lon, name, parent_station } = stopsMap[stopId];
            const linesSet = feedStops[stopId];
            const scale = getScaleForZoom(currentZoom);
            if (markerMap[stopId]) {
              markerMap[stopId].linesSet = linesSet;
              let isHighlighted = (highlightedMarker && highlightedMarker.stopId === stopId);
              markerMap[stopId].setIcon(createSvgIcon(stopId, linesSet, scale, isHighlighted));
            } else {
              const icon = createSvgIcon(stopId, linesSet, scale, false);
              const marker = L.marker([lat, lon], { icon: icon }).addTo(map);
              marker.stopId = stopId;
              marker.linesSet = linesSet;
              marker.on('click', () => {
                const previousStationId = lastClickedStationId;
                console.log("Clicked station id:", stopId);
                const destinationStationId = parent_station ? parent_station : stopId;
                console.log("Going towards station id:", destinationStationId);
                console.log("Came from station id:", previousStationId || "N/A");
                const clickedTrainTime = getFirstTrainTime(stopId);
                console.log("First train time for clicked station:", clickedTrainTime ? clickedTrainTime : "No upcoming trains");
                if (destinationStationId && destinationStationId !== stopId) {
                  const destTrainTime = getFirstTrainTime(destinationStationId);
                  console.log("First train time for destination station:", destTrainTime ? destTrainTime : "No upcoming trains");
                }
                if (previousStationId && previousStationId !== stopId) {
                  const previousTrainTime = getFirstTrainTime(previousStationId);
                  console.log("First train time for previous station:", previousTrainTime ? previousTrainTime : "No upcoming trains");
                }
                lastClickedStationId = stopId;
                if (highlightedMarker && highlightedMarker !== marker) {
                  const prevIcon = createSvgIcon(highlightedMarker.stopId, highlightedMarker.linesSet, getScaleForZoom(map.getZoom()), false);
                  highlightedMarker.setIcon(prevIcon);
                }
                highlightedMarker = marker;
                const highlightedIcon = createSvgIcon(stopId, linesSet, getScaleForZoom(map.getZoom()), true);
                marker.setIcon(highlightedIcon);
                const linesArray = Array.from(linesSet).sort();
                const borderColor = lineColors[linesArray[0]] || "#000000";
                window.currentPopupStopId = stopId;
                window.currentPopupLines = linesSet;
                showFixedPopup(stopId, name, linesSet, borderColor);
              });
              markerMap[stopId] = marker;
            }
          }
        });
      } else {
        // Remove station markers if zoom < 15.
        Object.keys(markerMap).forEach(stopId => {
          if (map.hasLayer(markerMap[stopId])) {
            map.removeLayer(markerMap[stopId]);
          }
        });
        hideFixedPopup();
      }

// --- Update train markers based on trip progress ---
currentTrainIds.clear();
combinedEntities.forEach(entity => {
  if (entity.tripUpdate && entity.tripUpdate.stopTimeUpdate) {
    const updates = entity.tripUpdate.stopTimeUpdate.filter(u => u.arrival && u.arrival.time);
    if (updates.length < 2) return;
    const nowSec = currentTimeSec;
    let passedStop = null, nextStop = null;
    updates.forEach(u => {
      const arrivalTime = parseInt(u.arrival.time);
      if (arrivalTime <= nowSec) {
        if (!passedStop || arrivalTime > parseInt(passedStop.arrival.time)) {
          passedStop = u;
        }
      } else {
        if (!nextStop || arrivalTime < parseInt(nextStop.arrival.time)) {
          nextStop = u;
        }
      }
    });
    if (passedStop && nextStop && stopsMap[passedStop.stopId] && stopsMap[nextStop.stopId]) {
      const departureTime = parseInt(passedStop.arrival.time);
      const arrivalTime = parseInt(nextStop.arrival.time);
      if (arrivalTime <= departureTime) return;
      let fraction = (nowSec - departureTime) / (arrivalTime - departureTime);
      fraction = Math.max(0, Math.min(1, fraction));

      const routeId = entity.tripUpdate.trip && entity.tripUpdate.trip.routeId 
                        ? entity.tripUpdate.trip.routeId.toUpperCase().trim() 
                        : "Unknown";
      let trainCoord;
      
      // Prepare points for snapping.
      const ptPassed = turf.point([stopsMap[passedStop.stopId].lon, stopsMap[passedStop.stopId].lat]);
      const ptNext = turf.point([stopsMap[nextStop.stopId].lon, stopsMap[nextStop.stopId].lat]);
      
      // Determine the polyline to use: prefer the matching route, otherwise choose the closest.
      let line = routeLines[routeId];
      if (!line) {
        let bestLine = null, bestDistance = Infinity;
        for (const key in routeLines) {
          const candidateLine = routeLines[key];
          const snappedCandidate = turf.nearestPointOnLine(candidateLine, ptPassed);
          const dist = turf.distance(ptPassed, snappedCandidate);
          if (dist < bestDistance) {
            bestDistance = dist;
            bestLine = candidateLine;
          }
        }
        line = bestLine;
      }
      
      if (line) {
        const snappedPassed = turf.nearestPointOnLine(line, ptPassed);
        const snappedNext = turf.nearestPointOnLine(line, ptNext);
        const d1 = snappedPassed.properties.location;
        const d2 = snappedNext.properties.location;
        const dCurrent = d1 + fraction * (d2 - d1);
        const trainPoint = turf.along(line, dCurrent, {units: 'kilometers'});
        trainCoord = [trainPoint.geometry.coordinates[1], trainPoint.geometry.coordinates[0]];
      } else {
        // Fallback: interpolate directly if no polyline found.
        const passedCoord = [stopsMap[passedStop.stopId].lat, stopsMap[passedStop.stopId].lon];
        const nextCoord = [stopsMap[nextStop.stopId].lat, stopsMap[nextStop.stopId].lon];
        trainCoord = interpolateCoords(passedCoord, nextCoord, fraction);
      }
      
      const timeStr = getRemainingTime(arrivalTime);
      const nextStationName = stopsMap[nextStop.stopId].name;
      const tripId = entity.tripUpdate.trip && entity.tripUpdate.trip.tripId ? entity.tripUpdate.trip.tripId : null;
      if (!tripId) return;
      currentTrainIds.add(tripId);
      const trainColor = lineColors[routeId] || "#0000FF";
      const newRadius = getTrainMarkerRadius(map.getZoom());
      
      // --- Build the popup content with station list (unchanged) ---
      const sortedUpdates = updates.slice().sort((a, b) => parseInt(a.arrival.time) - parseInt(b.arrival.time));
      let currentIdx = sortedUpdates.findIndex(u => parseInt(u.arrival.time) > nowSec) - 1;
      if (currentIdx < 0) currentIdx = 0;
      const startIdx = Math.max(0, currentIdx - 2);
      const endIdx = Math.min(sortedUpdates.length - 1, currentIdx + 2);
      let stationListHtml = '<div style="display:flex; flex-direction:column; gap:4px;">';
      for (let i = startIdx; i <= endIdx; i++) {
        const stopId = sortedUpdates[i].stopId;
        const stationName = stopsMap[stopId] ? stopsMap[stopId].name : stopId;
        if (i === currentIdx) {
          stationListHtml += `<div style="background:#e0f7fa; padding:4px 8px; border-radius:4px; font-weight:bold; color:#00796b;">${stationName}</div>`;
        } else {
          stationListHtml += `<div style="padding:4px 8px;">${stationName}</div>`;
        }
      }
      stationListHtml += '</div>';
      
      const popupHTML = `
        <div style="font-family: 'Arial', sans-serif; background:#fdfdfd; padding:12px; border-radius:8px; box-shadow:0 2px 6px rgba(0,0,0,0.2);">
          <div style="font-size:20px; font-weight:bold; margin-bottom:6px;">Train going to ${nextStationName}</div>
          <div style="font-size:16px; margin-bottom:10px;">Arriving in ${timeStr}</div>
          <div style="font-size:16px; margin-bottom:10px;">Current Stop: ${stopsMap[passedStop.stopId].name}</div>
          <div style="border-top:1px solid #ddd; margin:8px 0;"></div>
          <div style="font-size:16px; line-height:1.4;">
            ${stationListHtml}
          </div>
        </div>
      `;
      
      // Update or create train marker with the new popup content
      if (trainMarkers[tripId]) {
        trainMarkers[tripId].tripData = {
          passedCoord: [stopsMap[passedStop.stopId].lat, stopsMap[passedStop.stopId].lon],
          nextCoord: [stopsMap[nextStop.stopId].lat, stopsMap[nextStop.stopId].lon],
          departureTime: departureTime,
          arrivalTime: arrivalTime,
          routeId: routeId,
          nextStationName: nextStationName,
          updates: sortedUpdates,
          passedStopId: passedStop.stopId,
          trainColor: trainColor
        };
        trainMarkers[tripId].setLatLng(trainCoord);
        trainMarkers[tripId].setRadius(newRadius);
        trainMarkers[tripId].setPopupContent(popupHTML);
      } else {
        const newMarker = L.circleMarker(trainCoord, {
          radius: newRadius,
          color: trainColor,
          fillColor: trainColor,
          fillOpacity: 1
        }).bindPopup(popupHTML);
        newMarker.tripData = {
          passedCoord: [stopsMap[passedStop.stopId].lat, stopsMap[passedStop.stopId].lon],
          nextCoord: [stopsMap[nextStop.stopId].lat, stopsMap[nextStop.stopId].lon],
          departureTime: departureTime,
          arrivalTime: arrivalTime,
          routeId: routeId,
          nextStationName: nextStationName,
          updates: sortedUpdates,
          passedStopId: passedStop.stopId,
          trainColor: trainColor
        };
        trainMarkers[tripId] = newMarker;
        trainMarkersLayer.addLayer(newMarker);
      }
    }
  }
});
trainMarkersLayer.bringToFront();


    } catch (err) {
      console.error('Error updating feeds:', err);
    }
  }

// Interaction flag and debounce helper.
let isMapInteracting = false;
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

// Update polyline styles (debounced).
const updatePolylineStyles = debounce(() => {
  const currentZoom = map.getZoom();
  polylineLayers.forEach(layer => {
    layer.setStyle({ weight: getPolylineWeight(currentZoom) });
  });
  // Force a train marker update once interaction stops.
  updateTrainMarkerPositions();
}, 200);

// Set interaction flags using mousedown and mouseup.
map.on('mousedown', () => { 
  isMapInteracting = true; 
});
map.on('mouseup', () => { 
  isMapInteracting = false; 
  updatePolylineStyles();
});

  function updateTrainMarkerPositions() {
  const nowSec = currentTimeSec;
  const currentZoom = map.getZoom();
  const newRadius = getTrainMarkerRadius(currentZoom);
  trainMarkersLayer.eachLayer(marker => {
    const td = marker.tripData;
    if (td && td.arrivalTime > td.departureTime) {
      let fraction = (nowSec - td.departureTime) / (td.arrivalTime - td.departureTime);
      fraction = Math.max(0, Math.min(1, fraction));
      let newCoord;
      if (routeLines[td.routeId]) {
        const line = routeLines[td.routeId];
        const ptPassed = turf.point([td.passedCoord[1], td.passedCoord[0]]);
        const ptNext = turf.point([td.nextCoord[1], td.nextCoord[0]]);
        const snappedPassed = turf.nearestPointOnLine(line, ptPassed, { units: 'kilometers' });
        const snappedNext = turf.nearestPointOnLine(line, ptNext, { units: 'kilometers' });
        let d1 = snappedPassed.properties.location;
        let d2 = snappedNext.properties.location;
        if (d1 > d2) [d1, d2] = [d2, d1];
        const dCurrent = d1 + fraction * (d2 - d1);
        const trainPoint = turf.along(line, dCurrent, { units: 'kilometers' });
        newCoord = [trainPoint.geometry.coordinates[1], trainPoint.geometry.coordinates[0]];
      } else {
        newCoord = interpolateCoords(td.passedCoord, td.nextCoord, fraction);
      }
      marker.setLatLng(newCoord);
      marker.setRadius(newRadius);
      const timeStr = getRemainingTime(td.arrivalTime);
      
      // Rebuild the popup content using stored updates if available
      if (td.updates) {
        const sortedUpdates = td.updates;
        let currentIdx = sortedUpdates.findIndex(u => parseInt(u.arrival.time) > nowSec) - 1;
        if (currentIdx < 0) currentIdx = 0;
        const startIdx = Math.max(0, currentIdx - 2);
        const endIdx = Math.min(sortedUpdates.length - 1, currentIdx + 2);
        let stationListHtml = '<div style="display:flex; flex-direction:column; gap:4px;">';
        for (let i = startIdx; i <= endIdx; i++) {
          const stopId = sortedUpdates[i].stopId;
          const stationName = stopsMap[stopId] ? stopsMap[stopId].name : stopId;
          if (i === currentIdx) {
            stationListHtml += `<div style="background:#e0f7fa; padding:4px 8px; border-radius:4px; font-weight:bold; color:#00796b;">${stationName}</div>`;
          } else {
            stationListHtml += `<div style="padding:4px 8px;">${stationName}</div>`;
          }
        }
        stationListHtml += '</div>';
        const newPopupHTML = `
          <div style="font-family: 'Arial', sans-serif; background:#fdfdfd; padding:12px; width: 450px; border-radius:8px;">
            <div style="font-size:3em; font-weight:bold; margin-bottom:6px;">Train going to ${td.nextStationName}</div>
            <div style="font-size:2em; margin-bottom:10px;">Arriving in ${timeStr}</div>
            <div style="font-size:2em; margin-bottom:10px;">Current Stop: ${stopsMap[td.passedStopId].name}</div>
            <div style="border-top:1px solid #ddd; margin:8px 0;"></div>
            <div style="font-size:2em; line-height:1.4;">
              ${stationListHtml}
            </div>
          </div>
        `;
        marker.setPopupContent(newPopupHTML);
      } else {
        marker.setPopupContent(`<div style="font-size:20px;">Train going to ${td.nextStationName} arriving in ${timeStr}</div>`);
      }
    }
  });
  trainMarkersLayer.bringToFront();
}


  // Animation loop: only update markers when map is not interacting.
  function animate() {
    if (!isMapInteracting) {
      updateTrainMarkerPositions();
    }
    requestAnimationFrame(animate);
  }
  animate();

  // Load stops and update realtime feeds every 10 seconds.
  await loadStops();
  updateFeed();
  setInterval(updateFeed, 10000);

  // Adjust station marker sizes when zoom changes.
  map.on('zoomend', () => {
    const currentZoom = map.getZoom();
    if (currentZoom < 15) {
      Object.keys(markerMap).forEach(stopId => {
        if (map.hasLayer(markerMap[stopId])) {
          map.removeLayer(markerMap[stopId]);
        }
      });
      hideFixedPopup();
    } else {
      updateFeed();
      Object.keys(markerMap).forEach(stopId => {
        if (!map.hasLayer(markerMap[stopId])) {
          markerMap[stopId].addTo(map);
        }
      });
    }
  });

  // Hide popup and unselect highlighted station when map is clicked.
  map.on('click', () => {
    hideFixedPopup();
    if (highlightedMarker) {
      const normalIcon = createSvgIcon(
        highlightedMarker.stopId,
        highlightedMarker.linesSet,
        getScaleForZoom(map.getZoom()),
        false
      );
      highlightedMarker.setIcon(normalIcon);
      highlightedMarker = null;
    }
  });

});
