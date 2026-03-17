const MODULE_ID = "spell-list-compendium-replacer";

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
      const journal = app?.document;
      if (!journal) return;
      SpellCompendiumPickerApp.open({ journal });
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
      const journal = sheet?.document;
      if (!journal) return;
      SpellCompendiumPickerApp.open({ journal });
    },
  });
});

function shouldShowControl(app) {
  if (!game.user?.isGM) return false;

  const journal = app?.document;
  return journal?.documentName === "JournalEntry";
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
    this.journal = options.journal ?? null;
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
        await replaceJournalSpellLinks(this.journal, packCollection);
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

    map.set(key, `Compendium.${packCollection}.${entry._id}`);
  }

  return map;
}

function replaceLinksInContent(content, spellMap) {
  if (!content) return { content, replacements: 0 };

  let replacements = 0;

  const wrapper = document.createElement("div");
  wrapper.innerHTML = content;

  const links = wrapper.querySelectorAll("a.content-link, a.entity-link");
  for (const link of links) {
    const label = link.textContent?.trim();
    if (!label) continue;

    const replacementUuid = spellMap.get(normalizeName(label));
    if (!replacementUuid) continue;

    link.dataset.uuid = replacementUuid;
    delete link.dataset.pack;
    delete link.dataset.id;

    replacements += 1;
  }

  let updated = wrapper.innerHTML;

  updated = updated.replace(/@(UUID|Compendium)\[([^\]]+)\](?:\{([^}]+)\})?/gi, (match, _kind, _target, label) => {
    if (!label) return match;
    const replacementUuid = spellMap.get(normalizeName(label));
    if (!replacementUuid) return match;

    replacements += 1;
    return `@UUID[${replacementUuid}]{${label}}`;
  });

  return { content: updated, replacements };
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

async function replaceSpellReferencesInValue(value, spellMap, cache) {
  if (Array.isArray(value)) {
    let replacements = 0;
    const updated = [];

    for (const entry of value) {
      const result = await replaceSpellReferencesInValue(entry, spellMap, cache);
      replacements += result.replacements;
      updated.push(result.value);
    }

    return { value: updated, replacements };
  }

  if (value && typeof value === "object") {
    let replacements = 0;
    const updated = {};

    for (const [key, child] of Object.entries(value)) {
      const result = await replaceSpellReferencesInValue(child, spellMap, cache);
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

  updated = updated.replace(/@(UUID|Compendium)\[([^\]]+)\](?:\{([^}]+)\})?/gi, (match, _kind, _target, label) => {
    if (!label) return match;
    const replacementUuid = spellMap.get(normalizeName(label));
    if (!replacementUuid) return match;

    replacements += 1;
    return `@UUID[${replacementUuid}]{${label}}`;
  });

  if (updated.startsWith("Compendium.") || updated.startsWith("Item.")) {
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

async function replaceJournalSpellLinks(journal, packCollection) {
  const pack = game.packs.get(packCollection);
  if (!pack) {
    ui.notifications.error(game.i18n.localize(`${MODULE_ID}.notifications.missingPack`));
    return;
  }

  const index = await pack.getIndex({ fields: ["name", "type"] });
  const spellMap = getSpellMapFromIndex(index, packCollection);

  if (!spellMap.size) {
    ui.notifications.warn(game.i18n.localize(`${MODULE_ID}.notifications.noSpellEntries`));
    return;
  }

  const pageUpdates = [];
  let replacementCount = 0;
  const uuidNameCache = new Map();

  for (const page of journal.pages.contents) {
    if (page.type === "spells") {
      const currentSystem = foundry.utils.deepClone(page.system ?? {});
      const result = await replaceSpellReferencesInValue(currentSystem, spellMap, uuidNameCache);

      if (!result.replacements) continue;

      replacementCount += result.replacements;
      pageUpdates.push({
        _id: page.id,
        system: result.value,
      });
      continue;
    }

    if (page.type === "text") {
      const currentContent = page.text?.content ?? "";
      const { content, replacements } = replaceLinksInContent(currentContent, spellMap);
      if (!replacements || content === currentContent) continue;

      replacementCount += replacements;
      pageUpdates.push({
        _id: page.id,
        "text.content": content,
      });
    }
  }

  if (!pageUpdates.length) {
    ui.notifications.info(game.i18n.localize(`${MODULE_ID}.notifications.noChanges`));
    return;
  }

  await journal.updateEmbeddedDocuments("JournalEntryPage", pageUpdates);

  ui.notifications.info(
    game.i18n.format(`${MODULE_ID}.notifications.success`, {
      count: replacementCount,
      pages: pageUpdates.length,
    })
  );
}
