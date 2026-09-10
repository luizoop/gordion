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
     Ohne eigenen Server: Eingaben werden im localStorage protokolliert und
     mit dem Klick direkt an den Endpunkt übermittelt. Was nicht durchgeht,
     bleibt im Protokoll stehen und wird beim nächsten Seitenaufruf nachgereicht. */
  var formular = document.getElementById("gespraech-formular");
  if (formular) {
    var ENTWURF = "gordion:gespraech-entwurf";
    var PROTOKOLL = "gordion:gespraech-protokoll";
    var PROTOKOLL_MAX = 20;

    var endpunkt = formular.getAttribute("data-endpunkt") || "";
    var empfaenger = formular.getAttribute("data-empfaenger") || "";

    var status = document.getElementById("formular-status");
    var entwurfszeile = document.getElementById("formular-entwurf");
    var verwerfen = document.getElementById("entwurf-verwerfen");
    var knopf = formular.querySelector("button[type=submit]");

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

    /* --- Protokoll: jeder Terminwunsch steht hier, bis er quittiert ist. --- */
    var protokollLesen = function () {
      var liste = lesen(PROTOKOLL);
      return Array.isArray(liste) ? liste : [];
    };

    var protokollSchreiben = function (liste) {
      schreiben(PROTOKOLL, liste.slice(-PROTOKOLL_MAX));
    };

    var protokollErgaenzen = function (eintrag) {
      var liste = protokollLesen();
      liste.push(eintrag);
      protokollSchreiben(liste);
    };

    var protokollQuittieren = function (id) {
      var liste = protokollLesen().map(function (eintrag) {
        if (eintrag.id === id) {
          eintrag.gesendet = true;
          eintrag.uebermittelt = new Date().toISOString();
        }
        return eintrag;
      });
      protokollSchreiben(liste);
    };

    /* --- Übermittlung --- */
    var uebermitteln = function (eintrag) {
      if (!endpunkt) return Promise.reject(new Error("Kein Endpunkt hinterlegt."));

      return window.fetch(endpunkt, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify({
          _subject: "Terminwunsch" + (eintrag.haus ? ": " + eintrag.haus : ""),
          _template: "table",
          _captcha: "false",
          _replyto: eintrag.email,
          Name: eintrag.name,
          Haus: eintrag.haus,
          "E-Mail": eintrag.email,
          Telefon: eintrag.telefon || "—",
          Zeitfenster: eintrag.zeitfenster,
          Kontext: eintrag.nachricht || "—",
          Erfasst: eintrag.zeitpunkt,
          Seite: window.location.href
        })
      }).then(function (antwort) {
        return antwort.json().catch(function () {
          return {};
        }).then(function (daten) {
          if (!antwort.ok || String(daten.success) === "false") {
            throw new Error(daten.message || "Der Dienst hat die Übermittlung abgelehnt.");
          }
          return daten;
        });
      });
    };

    var arbeitet = function (ja) {
      if (!knopf) return;
      knopf.disabled = ja;
      knopf.textContent = ja ? "Wird übermittelt …" : "Terminwunsch senden";
    };

    /* Liegengebliebene Terminwünsche still nachreichen. */
    var nachreichen = function () {
      var offen = protokollLesen().filter(function (eintrag) {
        return !eintrag.gesendet;
      });
      if (!offen.length) return;

      offen.reduce(function (kette, eintrag) {
        return kette.then(function () {
          return uebermitteln(eintrag).then(function () {
            protokollQuittieren(eintrag.id);
            melden("Ein zwischengespeicherter Terminwunsch wurde nachträglich übermittelt.");
          });
        });
      }, Promise.resolve()).catch(function () {
        /* Bleibt im Protokoll und wird beim nächsten Aufruf erneut versucht. */
      });
    };

    entwurfLaden();
    nachreichen();

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
      var eintrag = {
        id: "tw-" + Date.now(),
        zeitpunkt: new Date().toISOString(),
        gesendet: false
      };
      felder.forEach(function (name) {
        eintrag[name] = daten.get(name) || "";
      });

      protokollErgaenzen(eintrag);
      arbeitet(true);
      melden("Wird übermittelt …");

      uebermitteln(eintrag).then(function () {
        protokollQuittieren(eintrag.id);
        loeschen(ENTWURF);
        formular.reset();
        formular.classList.remove("ist-geprueft");
        entwurfAnzeigen(false);
        melden("Angekommen — der Terminwunsch liegt bei Lucas Beneke. " +
               "Antwort in der Regel am nächsten Werktag.");
      }).catch(function (fehler) {
        /* Die Rohmeldung des Dienstes gehört in die Konsole, nicht vor den Besucher. */
        if (window.console) window.console.warn("Terminwunsch nicht übermittelt:", fehler.message);

        melden(
          (/activat/i.test(fehler.message)
            ? "Der Versandweg ist noch nicht freigeschaltet."
            : "Die Übermittlung hat gerade nicht geklappt.") +
          " Der Terminwunsch ist auf diesem Gerät gespeichert und wird beim nächsten " +
          "Aufruf automatisch erneut gesendet." + (empfaenger ? " Direkt: " + empfaenger : ""),
          true
        );
      }).then(function () {
        arbeitet(false);
      });
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
