(function () {
  "use strict";

  var ruhig = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* Sticky-Header: untere Haarlinie erst beim Scrollen. */
  var kopf = document.getElementById("kopf");
  if (kopf) {
    var pruefen = function () {
      kopf.classList.toggle("ist-gescrollt", window.scrollY > 0);
    };
    pruefen();
    window.addEventListener("scroll", pruefen, { passive: true });
  }

  /* Terminformular auf der Seite "Gespräch vereinbaren".
     Ohne Server: Eingaben liegen im localStorage des Besuchers, der
     Terminwunsch geht als vorbereitete E-Mail an den Empfänger raus. */
  var formular = document.getElementById("gespraech-formular");
  if (formular) {
    var ENTWURF = "gordion:gespraech-entwurf";
    var ARCHIV = "gordion:gespraech-anfragen";
    var ARCHIV_MAX = 20;

    var status = document.getElementById("formular-status");
    var entwurfszeile = document.getElementById("formular-entwurf");
    var verwerfen = document.getElementById("entwurf-verwerfen");

    /* Die Einwilligung wird bewusst nicht gesichert: ein aus einer
       früheren Sitzung wiederhergestelltes Häkchen wäre keine Einwilligung. */
    var felder = ["name", "haus", "email", "telefon", "zeitfenster", "nachricht"];

    var melden = function (text, fehler) {
      if (!status) return;
      status.textContent = text;
      status.classList.toggle("ist-fehler", Boolean(fehler));
    };

    /* localStorage kann fehlen (privater Modus, geblockte Website-Daten). */
    var lesen = function (schluessel) {
      try {
        var roh = window.localStorage.getItem(schluessel);
        return roh ? JSON.parse(roh) : null;
      } catch (fehler) {
        return null;
      }
    };

    var schreiben = function (schluessel, wert) {
      try {
        window.localStorage.setItem(schluessel, JSON.stringify(wert));
        return true;
      } catch (fehler) {
        return false;
      }
    };

    var loeschen = function (schluessel) {
      try {
        window.localStorage.removeItem(schluessel);
      } catch (fehler) {
        /* nichts zu tun */
      }
    };

    var eingaben = function () {
      return felder.map(function (name) {
        return formular.elements[name];
      }).filter(Boolean);
    };

    var entwurfAnzeigen = function (sichtbar) {
      if (entwurfszeile) entwurfszeile.hidden = !sichtbar;
    };

    var entwurfSichern = function () {
      var stand = {};
      var etwasDrin = false;

      eingaben().forEach(function (feld) {
        stand[feld.name] = feld.value;
        if (feld.value.trim() !== "" && feld.type !== "select-one") etwasDrin = true;
      });

      if (!etwasDrin) {
        loeschen(ENTWURF);
        entwurfAnzeigen(false);
        return;
      }

      stand.gespeichert = new Date().toISOString();
      entwurfAnzeigen(schreiben(ENTWURF, stand));
    };

    var entwurfLaden = function () {
      var stand = lesen(ENTWURF);
      if (!stand) return;

      eingaben().forEach(function (feld) {
        if (typeof stand[feld.name] === "string") feld.value = stand[feld.name];
      });

      entwurfAnzeigen(true);
      melden("Zwischengespeicherte Eingaben von diesem Gerät wiederhergestellt.");
    };

    var archivieren = function (daten) {
      var bisher = lesen(ARCHIV);
      if (!Array.isArray(bisher)) bisher = [];
      bisher.push(daten);
      schreiben(ARCHIV, bisher.slice(-ARCHIV_MAX));
    };

    var zeile = function (name, wert) {
      return wert ? name + ": " + wert + "\n" : "";
    };

    entwurfLaden();

    formular.addEventListener("input", entwurfSichern);
    formular.addEventListener("change", entwurfSichern);

    if (verwerfen) {
      verwerfen.addEventListener("click", function () {
        loeschen(ENTWURF);
        formular.reset();
        formular.classList.remove("ist-geprueft");
        entwurfAnzeigen(false);
        melden("Entwurf verworfen.");
      });
    }

    formular.addEventListener("submit", function (ereignis) {
      ereignis.preventDefault();
      formular.classList.add("ist-geprueft");

      if (!formular.checkValidity()) {
        var ersteLuecke = formular.querySelector(":invalid");
        if (ersteLuecke) ersteLuecke.focus();
        melden("Bitte Name, Haus, E-Mail und die Einwilligung ergänzen.", true);
        return;
      }

      var daten = new FormData(formular);
      var empfaenger = formular.getAttribute("data-mail") || "";
      var haus = daten.get("haus") || "";

      var text =
        zeile("Name", daten.get("name")) +
        zeile("Haus", haus) +
        zeile("E-Mail", daten.get("email")) +
        zeile("Telefon", daten.get("telefon")) +
        zeile("Zeitfenster", daten.get("zeitfenster")) +
        "\n" + (daten.get("nachricht") || "");

      var eintrag = { gesendet: new Date().toISOString() };
      felder.forEach(function (name) {
        eintrag[name] = daten.get(name) || "";
      });
      archivieren(eintrag);

      window.location.href =
        "mailto:" + empfaenger +
        "?subject=" + encodeURIComponent("Terminwunsch" + (haus ? ": " + haus : "")) +
        "&body=" + encodeURIComponent(text);

      loeschen(ENTWURF);
      entwurfAnzeigen(false);
      melden("E-Mail an " + empfaenger + " wird vorbereitet — bitte dort noch abschicken.");
    });
  }

  /* Hero-Zähler, Phase 4 (3,2–4,0 s). */
  var zaehler = document.getElementById("hero-zaehler");
  if (!zaehler) return;

  var ZIEL = 5;

  if (ruhig) {
    zaehler.textContent = String(ZIEL);
    return;
  }

  window.setTimeout(function () {
    var start = null;
    var dauer = 800;

    var schritt = function (zeit) {
      if (start === null) start = zeit;
      var anteil = Math.min((zeit - start) / dauer, 1);
      zaehler.textContent = String(Math.round(anteil * ZIEL));
      if (anteil < 1) window.requestAnimationFrame(schritt);
    };

    window.requestAnimationFrame(schritt);
  }, 3200);
})();
