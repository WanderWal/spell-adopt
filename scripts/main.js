const MODULE_ID = "spell-adopt";

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

  return document.pages?.some((page) => isSpellListPage(page)) ?? false;
}

function isSpellListPage(document) {
  if (!document) return false;
  const type = document.type ?? "";
  return document.documentName === "JournalEntryPage"
    && (type === "spells" || type === "dnd5e.spells");
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

function getSpellMapFromIndex(index, packCollection) {
  const map = new Map();

  for (const entry of index) {
    const type = entry?.type ?? entry?.system?.type?.value;
    if (type !== "spell") continue;

    const key = normalizeName(entry.name);
    if (!key || map.has(key)) continue;

    map.set(key, `Compendium.${packCollection}.Item.${entry._id}`);
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
  const existingUuids = [...(page.system?.spells ?? [])];
  if (!existingUuids.length) return 0;

  const newUuids = [];
  let replacements = 0;

  for (const uuid of existingUuids) {
    const spellName = await getSpellNameFromUuid(uuid, uuidNameCache);
    const replacementUuid = spellName ? spellMap.get(normalizeName(spellName)) : null;

    if (replacementUuid && replacementUuid !== uuid) {
      newUuids.push(replacementUuid);
      replacements++;
    } else {
      newUuids.push(uuid);
    }
  }

  if (!replacements) return 0;

  await page.update({ "system.spells": newUuids });
  return replacements;
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

  const spellPages = target.pages?.filter((page) => isSpellListPage(page)) ?? [];
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
