const MODULE_ID = "spell-adopt";
const SPELL_COLLECTION_KEYS = new Set([
  "spell",
  "spells",
  "spelllist",
  "spelllists",
  "entries",
  "items",
  "results",
  "documents",
  "references",
]);
const SPELL_REFERENCE_KEYS = new Set([
  "uuid",
  "sourceid",
  "pack",
  "collection",
  "documentcollection",
  "id",
  "_id",
  "itemid",
  "documentid",
  "value",
]);

Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
  if (!Array.isArray(controls)) return;
  if (!shouldShowControl(app)) return;

  controls.unshift({
    action: "slcr-replace-spells",
    class: "slcr-replace-spells",
    icon: "fas fa-wand-magic-sparkles",
    label: game.i18n.localize(`${MODULE_ID}.button.replace`),
    visible: true,
    onClick: async () => {
      const target = app?.document;
      if (!target) return;
      SpellCompendiumPickerApp.open({ target });
    },
  });
});

Hooks.on("getJournalSheetHeaderButtons", (sheet, buttons) => {
  if (!Array.isArray(buttons)) return;
  if (!shouldShowControl(sheet)) return;

  const existing = buttons.find((button) => button?.class === "slcr-replace-spells");
  if (existing) return;

  buttons.unshift({
    class: "slcr-replace-spells",
    icon: "fas fa-wand-magic-sparkles",
    label: game.i18n.localize(`${MODULE_ID}.button.replace`),
    onclick: async () => {
      const target = sheet?.document;
      if (!target) return;
      SpellCompendiumPickerApp.open({ target });
    },
  });
});

function shouldShowControl(app) {
  if (!game.user?.isGM) return false;

  const document = app?.document;
  if (!document) return false;

  if (isSpellListPage(document)) return true;
  if (document.documentName !== "JournalEntry") return false;

  return document.pages?.some((page) => page.type === "spells") ?? false;
}

function isSpellListPage(document) {
  return document?.documentName === "JournalEntryPage" && document.type === "spells";
}

class SpellCompendiumPickerApp extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: "slcr-compendium-picker",
    classes: ["slcr-compendium-picker", "standard-form"],
    position: { width: 420, height: "auto" },
    window: { resizable: false },
  };

  constructor(options = {}) {
    super(options);
    this.target = options.target ?? null;
  }

  get title() {
    return game.i18n.localize(`${MODULE_ID}.picker.title`);
  }

  async _prepareContext() {
    const packs = game.packs
      .filter((pack) => pack.documentName === "Item" && pack.visible)
      .map((pack) => ({
        id: pack.collection,
        label: `${pack.metadata?.label ?? pack.title} (${pack.collection})`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    return { packs };
  }

  async _renderHTML(context) {
    const root = document.createElement("div");

    if (!context.packs.length) {
      root.innerHTML = `<p>${game.i18n.localize(`${MODULE_ID}.picker.none`)}</p>`;
      return root;
    }

    const options = context.packs
      .map((pack) => `<option value="${foundry.utils.escapeHTML(pack.id)}">${foundry.utils.escapeHTML(pack.label)}</option>`)
      .join("");

    root.innerHTML = `
      <form class="slcr-form">
        <div class="form-group">
          <label for="slcr-pack-select">${game.i18n.localize(`${MODULE_ID}.picker.label`)}</label>
          <select id="slcr-pack-select" name="pack" required>${options}</select>
        </div>
        <footer class="form-footer" style="margin-top:0.75rem;display:flex;justify-content:flex-end;">
          <button type="submit" class="slcr-submit">
            <i class="fas fa-arrows-rotate"></i> ${game.i18n.localize(`${MODULE_ID}.picker.submit`)}
          </button>
        </footer>
      </form>
    `;

    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    this.#attachListeners(content);
  }

  #attachListeners(content) {
    const form = content.querySelector(".slcr-form");
    if (!form) return;

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (!game.user?.isGM) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.gmOnly`));
        return;
      }

      const packCollection = form.querySelector("select[name='pack']")?.value?.trim();
      if (!packCollection) {
        ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.selectPack`));
        return;
      }

      const submitButton = form.querySelector(".slcr-submit");
      if (submitButton) submitButton.disabled = true;

      try {
        await replaceSpellListTarget(this.target, packCollection);
        this.close();
      } finally {
        if (submitButton) submitButton.disabled = false;
      }
    });
  }

  static open(options = {}) {
    const app = new SpellCompendiumPickerApp(options);
    app.render(true);
    return app;
  }
}

function normalizeName(name) {
  return String(name ?? "").trim().toLowerCase();
}

function parseCompendiumUuid(uuid) {
  if (typeof uuid !== "string") return null;

  const withType = uuid.match(/^Compendium\.(.+)\.Item\.([^\.]+)$/);
  if (withType) {
    return {
      pack: withType[1],
      id: withType[2],
    };
  }

  const withoutType = uuid.match(/^Compendium\.(.+)\.([^\.]+)$/);
  if (withoutType) {
    return {
      pack: withoutType[1],
      id: withoutType[2],
    };
  }

  return null;
}

function buildSpellReferenceFields(replacementUuid) {
  const parsed = parseCompendiumUuid(replacementUuid);
  if (!parsed) {
    return { uuid: replacementUuid, sourceId: replacementUuid };
  }

  return {
    uuid: replacementUuid,
    sourceId: replacementUuid,
    pack: parsed.pack,
    collection: parsed.pack,
    documentCollection: parsed.pack,
    id: parsed.id,
    _id: parsed.id,
    itemId: parsed.id,
    documentId: parsed.id,
  };
}

function getSpellMapFromIndex(index, packCollection) {
  const map = new Map();

  for (const entry of index) {
    const type = entry?.type ?? entry?.system?.type?.value;
    if (type !== "spell") continue;

    const key = normalizeName(entry.name);
    if (!key || map.has(key)) continue;

    map.set(key, `Compendium.${packCollection}.${entry._id}`);
  }

  return map;
}

async function getSpellNameFromUuid(uuid, cache) {
  if (!uuid) return null;
  if (cache.has(uuid)) return cache.get(uuid);

  let resolvedName = null;

  try {
    const document = await fromUuid(uuid);
    if (document?.documentName === "Item" && document.type === "spell") {
      resolvedName = document.name ?? null;
    }
  } catch (_error) {
    resolvedName = null;
  }

  cache.set(uuid, resolvedName);
  return resolvedName;
}

function isSpellCollectionKey(key) {
  return SPELL_COLLECTION_KEYS.has(String(key ?? "").toLowerCase());
}

function isSpellReferenceKey(key) {
  return SPELL_REFERENCE_KEYS.has(String(key ?? "").toLowerCase());
}

function objectLooksLikeSpellReference(value) {
  if (!value || typeof value !== "object") return false;

  return Object.keys(value).some((key) => isSpellReferenceKey(key))
    || [value.name, value.label, value.title, value.spellName].some((entry) => typeof entry === "string" && entry.trim());
}

async function replaceSpellReferencesInValue(value, spellMap, cache, context = {}) {
  const key = String(context.key ?? "");
  const insideSpellCollection = Boolean(context.insideSpellCollection) || isSpellCollectionKey(key);

  if (Array.isArray(value)) {
    let replacements = 0;
    const updated = [];

    for (const entry of value) {
      const result = await replaceSpellReferencesInValue(entry, spellMap, cache, {
        key,
        insideSpellCollection,
      });
      replacements += result.replacements;
      updated.push(result.value);
    }

    return { value: updated, replacements };
  }

  if (value && typeof value === "object") {
    const objectIsSpellReference = objectLooksLikeSpellReference(value);
    const possibleName = value.name ?? value.label ?? value.title ?? value.spellName ?? null;
    const matchedByName = spellMap.get(normalizeName(possibleName));

    if (matchedByName && (insideSpellCollection || objectIsSpellReference)) {
      let replacements = 0;
      const updated = foundry.utils.deepClone(value);
      const referenceFields = buildSpellReferenceFields(matchedByName);

      for (const [key, fieldValue] of Object.entries(referenceFields)) {
        if (updated[key] !== fieldValue) {
          updated[key] = fieldValue;
          replacements += 1;
        }
      }

      if (replacements > 0) {
        return { value: updated, replacements };
      }
    }

    let replacements = 0;
    const updated = {};

    for (const [key, child] of Object.entries(value)) {
      const result = await replaceSpellReferencesInValue(child, spellMap, cache, {
        key,
        insideSpellCollection,
      });
      replacements += result.replacements;
      updated[key] = result.value;
    }

    return { value: updated, replacements };
  }

  if (typeof value !== "string") {
    return { value, replacements: 0 };
  }

  let replacements = 0;
  let updated = value;

  const matchedByName = spellMap.get(normalizeName(updated));
  if ((insideSpellCollection || isSpellReferenceKey(key)) && matchedByName && matchedByName !== updated) {
    return { value: matchedByName, replacements: 1 };
  }

  updated = updated.replace(/@(UUID|Compendium)\[([^\]]+)\](?:\{([^}]+)\})?/gi, (match, _kind, _target, label) => {
    if (!label) return match;
    const replacementUuid = spellMap.get(normalizeName(label));
    if (!replacementUuid) return match;

    replacements += 1;
    return `@UUID[${replacementUuid}]{${label}}`;
  });

  if (updated.startsWith("Compendium.")) {
    const spellName = await getSpellNameFromUuid(updated, cache);
    if (spellName) {
      const replacementUuid = spellMap.get(normalizeName(spellName));
      if (replacementUuid && replacementUuid !== updated) {
        replacements += 1;
        updated = replacementUuid;
      }
    }
  }

  return { value: updated, replacements };
}

async function getSpellMapForPack(packCollection) {
  const pack = game.packs.get(packCollection);
  if (!pack) {
    ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notifications.missingPack`));
    return null;
  }

  const index = await pack.getIndex({ fields: ["name", "type"] });
  const spellMap = getSpellMapFromIndex(index, packCollection);

  if (!spellMap.size) {
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.noSpellEntries`));
    return null;
  }

  return spellMap;
}

async function replaceSpellListPage(page, spellMap, uuidNameCache) {
  const currentData = page.toObject();
  const result = await replaceSpellReferencesInValue(currentData, spellMap, uuidNameCache, {
    key: "page",
    insideSpellCollection: false,
  });

  if (!result.replacements) return 0;

  const updateData = foundry.utils.diffObject(currentData, result.value);
  delete updateData._id;

  if (!Object.keys(updateData).length) return 0;

  await page.update(updateData);
  return result.replacements;
}

async function replaceSpellListTarget(target, packCollection) {
  const spellMap = await getSpellMapForPack(packCollection);
  if (!spellMap) return;

  const uuidNameCache = new Map();

  if (isSpellListPage(target)) {
    const replacementCount = await replaceSpellListPage(target, spellMap, uuidNameCache);

    if (!replacementCount) {
      ui.notifications.info(game.i18n.localize(`${MODULE_ID}.notifications.noChanges`));
      return;
    }

    ui.notifications.info(
      game.i18n.format(`${MODULE_ID}.notifications.success`, {
        count: replacementCount,
        pages: 1,
      })
    );
    return;
  }

  if (target?.documentName !== "JournalEntry") {
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.invalidTarget`));
    return;
  }

  const spellPages = target.pages?.filter((page) => page.type === "spells") ?? [];
  if (!spellPages.length) {
    ui.notifications.info(game.i18n.localize(`${MODULE_ID}.notifications.noSpellPages`));
    return;
  }

  let replacementCount = 0;
  let updatedPages = 0;

  for (const page of spellPages) {
    const replacements = await replaceSpellListPage(page, spellMap, uuidNameCache);
    if (!replacements) continue;

    replacementCount += replacements;
    updatedPages += 1;
  }

  if (!updatedPages) {
    ui.notifications.info(game.i18n.localize(`${MODULE_ID}.notifications.noChanges`));
    return;
  }

  ui.notifications.info(
    game.i18n.format(`${MODULE_ID}.notifications.success`, {
      count: replacementCount,
      pages: updatedPages,
    })
  );
}
