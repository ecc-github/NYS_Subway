// script.js

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
  // Expose getFirstTrainTime globally.
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
    const { minutes, seconds } = formatTimeComponents(deltaSec);
    return `${minutes} min ${seconds < 10 ? "0" + seconds : seconds} sec`;
  }

  // Helper: returns a formatted remaining time string using the common time reference.
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
    const baseZoom = 16;
    const factorPerZoom = 0.4;
    return Math.max(0.2, 1 + (zoom - baseZoom) * factorPerZoom);
  }

  // Create a custom SVG icon as a Leaflet divIcon.
  function createSvgIcon(stopId, lines, scale = 1, highlight = false) {
    let svgHTML = "";
    let iconSize = [0, 0];
    if (highlight) {
      scale = scale * 1.5;
    }
    if (lines && lines.size > 0) {
      const linesArray = Array.from(lines).sort();
      const count = linesArray.length;
      if (scale < 1.3) {
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
    let formatted = "";
    if (hours > 0) {
      formatted = hours + " hrs " + minutes + " min";
    } else {
      if (minutes < 5) {
        formatted = minutes + " min " + (seconds < 10 ? "0" + seconds : seconds) + " sec";
      } else {
        formatted = minutes + " min";
      }
    }
    if (isPast) {
      formatted = "- " + formatted;
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
        times = times.slice(0, 100);
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

  // Expose getFirstTrainTime globally.
  window.getFirstTrainTime = getFirstTrainTime;

  // --- NEW: Global dictionary to store route polylines by route_id ---
  let routeLines = {};

  // Load and add the GeoJSON layer for train lines and store route polylines.
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
          // Store the polyline by route_id.
          routeLines[routeId] = offsetLine;
          return offsetLine;
        }
        return feature;
      });
      
      const offsetGeoJson = {
        type: "FeatureCollection",
        features: offsetFeatures
      };
      
      L.geoJSON(offsetGeoJson, {
        style: function(feature) {
          const routeId = feature.properties.route_id;
          return {
            color: lineColors[routeId] || "#000000",
            weight: 5,
            opacity: 0.8
          };
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

      // Reset feedTimes and build feedStops.
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

      // --- Update station markers (only if zoom >= 15) ---
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
        // If zoom is below 15, remove station markers.
        Object.keys(markerMap).forEach(stopId => {
          if (map.hasLayer(markerMap[stopId])) {
            map.removeLayer(markerMap[stopId]);
          }
        });
        hideFixedPopup();
      }

      // --- Update train markers based on trip progress ---
      // Do not remove existing train markers; update their positions.
      currentTrainIds.clear();
      combinedEntities.forEach(entity => {
        if (entity.tripUpdate && entity.tripUpdate.stopTimeUpdate) {
          const updates = entity.tripUpdate.stopTimeUpdate.filter(u => u.arrival && u.arrival.time);
          if (updates.length < 2) return;
          const nowSec = currentTimeSec;
          let passedStop = null;
          let nextStop = null;
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
            // Set departureTime equal to passedStop arrival time (no extra wait time)
            const departureTime = parseInt(passedStop.arrival.time);
            const arrivalTime = parseInt(nextStop.arrival.time);
            if (arrivalTime <= departureTime) return;
            let fraction = (nowSec - departureTime) / (arrivalTime - departureTime);
            fraction = Math.max(0, Math.min(1, fraction));

            // Use route polyline if available.
            const routeId = entity.tripUpdate.trip && entity.tripUpdate.trip.routeId 
                              ? entity.tripUpdate.trip.routeId.toUpperCase().trim() 
                              : "Unknown";
            let trainCoord;
            if (routeLines[routeId]) {
              const line = routeLines[routeId];
              const ptPassed = turf.point([stopsMap[passedStop.stopId].lon, stopsMap[passedStop.stopId].lat]);
              const ptNext = turf.point([stopsMap[nextStop.stopId].lon, stopsMap[nextStop.stopId].lat]);
              const snappedPassed = turf.nearestPointOnLine(line, ptPassed);
              const snappedNext = turf.nearestPointOnLine(line, ptNext);
              const d1 = snappedPassed.properties.location;
              const d2 = snappedNext.properties.location;
              const dCurrent = d1 + fraction * (d2 - d1);
              const trainPoint = turf.along(line, dCurrent, {units: 'kilometers'});
              trainCoord = [trainPoint.geometry.coordinates[1], trainPoint.geometry.coordinates[0]];
            } else {
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
            const trainMarkerRadius = 12;  // Fixed size of 12 pixels
            if (trainMarkers[tripId]) {
              trainMarkers[tripId].tripData = {
                passedCoord: [stopsMap[passedStop.stopId].lat, stopsMap[passedStop.stopId].lon],
                nextCoord: [stopsMap[nextStop.stopId].lat, stopsMap[nextStop.stopId].lon],
                departureTime: departureTime,
                arrivalTime: arrivalTime,
                routeId: routeId,
                nextStationName: nextStationName
              };
              trainMarkers[tripId].setLatLng(trainCoord);
              trainMarkers[tripId].setRadius(trainMarkerRadius);
              trainMarkers[tripId].setPopupContent(`<div style="font-size:20px;">Train going to ${nextStationName} arriving in ${timeStr}</div>`);
            } else {
              const newMarker = L.circleMarker(trainCoord, {
                radius: trainMarkerRadius,
                color: trainColor,
                fillColor: trainColor,
                fillOpacity: 1
              }).bindPopup(`<div style="font-size:20px;">Train going to ${nextStationName} arriving in ${timeStr}</div>`);
              newMarker.tripData = {
                passedCoord: [stopsMap[passedStop.stopId].lat, stopsMap[passedStop.stopId].lon],
                nextCoord: [stopsMap[nextStop.stopId].lat, stopsMap[nextStop.stopId].lon],
                departureTime: departureTime,
                arrivalTime: arrivalTime,
                routeId: routeId,
                nextStationName: nextStationName
              };
              trainMarkers[tripId] = newMarker;
              trainMarkersLayer.addLayer(newMarker);
            }
          }
        }
      });


      // Bring the train marker layer to the front.
      trainMarkersLayer.bringToFront();

    } catch (err) {
      console.error('Error updating feeds:', err);
    }
  }

  // Function to update train marker positions every second.
  function updateTrainMarkerPositions() {
    const currentZoom = map.getZoom();
    const nowSec = currentTimeSec;
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
          const snappedPassed = turf.nearestPointOnLine(line, ptPassed);
          const snappedNext = turf.nearestPointOnLine(line, ptNext);
          const d1 = snappedPassed.properties.location;
          const d2 = snappedNext.properties.location;
          const dCurrent = d1 + fraction * (d2 - d1);
          const trainPoint = turf.along(line, dCurrent, {units: 'kilometers'});
          newCoord = [trainPoint.geometry.coordinates[1], trainPoint.geometry.coordinates[0]];
        } else {
          newCoord = interpolateCoords(td.passedCoord, td.nextCoord, fraction);
        }
        marker.setLatLng(newCoord);
        marker.setRadius(12);  // Fixed radius of 12 pixels
        const timeStr = getRemainingTime(td.arrivalTime);
        marker.setPopupContent(`<div style="font-size:20px;">Train going to ${td.nextStationName} arriving in ${timeStr}</div>`);
      }
    });
    trainMarkersLayer.bringToFront();
  }


  // Load stops and update realtime feeds every 10 seconds.
  await loadStops();
  updateFeed();
  setInterval(updateFeed, 10000);

  // Update train marker positions every second.
  setInterval(updateTrainMarkerPositions, 1000);

  // Adjust station marker sizes when zoom changes.
  map.on('zoomend', () => {
    const currentZoom = map.getZoom();
    if (currentZoom < 14) {
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

  // Load and add the GeoJSON layer for train lines.
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
          // Store the route polyline.
          routeLines[routeId] = offsetLine;
          return offsetLine;
        }
        return feature;
      });
      const offsetGeoJson = {
        type: "FeatureCollection",
        features: offsetFeatures
      };
      L.geoJSON(offsetGeoJson, {
        style: function(feature) {
          const routeId = feature.properties.route_id;
          return {
            color: lineColors[routeId] || "#000000",
            weight: 5,
            opacity: 0.8
          };
        }
      }).addTo(map);
    })
    .catch(err => console.error("Error loading GeoJSON:", err));

});
