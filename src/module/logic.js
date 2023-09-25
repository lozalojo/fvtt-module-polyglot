/* eslint-disable no-undef */
import { FONTS } from "./Fonts.js";
import PolyglotHooks from "./hooks.js";

export class Polyglot {
	constructor() {
		this.knownLanguages = new Set();
		this.literateLanguages = new Set();
		this.refreshTimeout = null;
		this.FONTS = FONTS;
		// TODO consider removing this variable and let LanguageProvider handle it instead
		this.CustomFontSizes = game.settings.get("polyglot", "CustomFontSizes");
		this.registerModule = null;
		this.registerSystem = null;
	}

	init() {
		for (let hook of Object.getOwnPropertyNames(PolyglotHooks)) {
			if (!["length", "name", "prototype"].includes(hook)) {
				Hooks.on(hook, PolyglotHooks[hook]);
			}
		}
		libWrapper.register("polyglot", "JournalTextPageSheet.prototype.activateEditor", this.activateEditorWrapper.bind(this), "WRAPPER");
		/**
		 * Speak a message as a particular Token, displaying it as a chat bubble
		 * WRAPPER:
		 * 	Scrambles the message's text if a language is present.
		 * @param {Token} token                   The speaking Token
		 * @param {string} message                The spoken message text
		 * @param {ChatBubbleOptions} [options]   Options which affect the bubble appearance
		 * @returns {Promise<jQuery|null>}        A Promise which resolves to the created bubble HTML element, or null
		 */
		libWrapper.register(
			"polyglot",
			"ChatBubbles.prototype.say",
			async (wrapped, token, message, { cssClasses, requireVisible = false, pan = true, language = "" } = {}) => {
				if (game.user.isGM && !game.settings.get("polyglot", "runifyGM")) {
					return wrapped(token, message, { cssClasses, requireVisible, pan });
				}
				let lang = "";
				let randomId = "";
				if (language) {
					randomId = foundry.utils.randomID(16);
					if (this.languageProvider.languages[language]) {
						lang = language;
					} else {
						Object.values(this.languageProvider.languages).every((l) => {
							if (language === l.label) {
								lang = language;
								return false;
							}
							return true;
						});
					}
				} else {
					// Find the message out of the last 10 chat messages, last to first
					const gameMessages = game.messages.contents
						.slice(-10)
						.reverse()
						.find((m) => m.content === message);
					// Message was sent in-character (no /ooc or /emote)
					if (gameMessages?.type === CONST.CHAT_MESSAGE_TYPES.IC) {
						lang = gameMessages.getFlag("polyglot", "language") || "";
						randomId = gameMessages.id;
					}
				}
				if (lang) {
					//Language isn't truespeech, isn't known and user isn't under Comprehend Languages effect
					const unknown = !this.isLanguageknownOrUnderstood(lang);
					if (unknown) {
						message = this.scrambleString(message, randomId, lang);
						document.documentElement.style.setProperty("--polyglot-chat-bubble-font", this._getFontStyle(lang).replace(/\d+%\s/g, ""));
						if (cssClasses == undefined) cssClasses = [];
						cssClasses.push("polyglot-chat-bubble");
					}
				}
				return wrapped(token, message, { cssClasses, requireVisible, pan });
			},
			"WRAPPER",
		);
	}

	get chatElement() {
		return ui.sidebar.popouts.chat?.element || ui.chat.element;
	}

	/**
	 * @returns {object}
	 */
	get alphabets() {
		return this.languageProvider.alphabets;
	}

	/**
	 * Returns an object or array, based on the game system's own data structure.
	 *
	 * @returns {object|array}
	 */
	get languages() {
		return this.languageProvider.languages;
	}

	/**
	 * @returns {String}
	 */
	get defaultLanguage() {
		return this.languageProvider.defaultLanguage;
	}

	get omniglot() {
		return this._omniglot;
	}

	set omniglot(lang) {
		this.languageProvider.addLanguage(lang);
		lang = lang.trim().toLowerCase().replace(/[\s']/g, "_");
		if (lang === this._omniglot) return;
		if (this._omniglot) this.languageProvider.removeLanguage(this._omniglot);
		this._omniglot = lang;
	}

	get comprehendLanguages() {
		return this._comprehendLanguages;
	}

	set comprehendLanguages(lang) {
		this.languageProvider.addLanguage(lang);
		lang = lang.trim().toLowerCase().replace(/[\s']/g, "_");
		if (lang === this._comprehendLanguages) return;
		if (this._comprehendLanguages) this.languageProvider.removeLanguage(this._comprehendLanguages);
		this._comprehendLanguages = lang;
	}

	get truespeech() {
		return this._truespeech;
	}

	set truespeech(lang) {
		const key = lang.trim().toLowerCase().replace(/[\s']/g, "_");
		if (key === this._truespeech) return;
		this.languageProvider.addLanguage(lang);
		this.languageProvider.removeLanguage(this._truespeech);
		this._truespeech = key;
	}

	/* -------------------------------------------- */
	/*  Hooks	                                    */
	/* -------------------------------------------- */

	/**
	 * Updates the chat messages.
	 * It has a delay because switching tokens could cause a controlToken(false) then controlToken(true) very fast.
	 */
	updateChatMessages() {
		if (this.refreshTimeout) clearTimeout(this.refreshTimeout);
		this.refreshTimeout = setTimeout(this.updateChatMessagesDelayed.bind(this), 500);
	}

	/**
	 * Updates the last 100 messages. Loop in reverse so most recent messages get refreshed first.
	 */
	updateChatMessagesDelayed() {
		this.refreshTimeout = null;
		const messages = this.chatElement
			.find(".message")
			.slice(-100)
			.toArray()
			.map((m) => game.messages.get(m.dataset.messageId));
		for (let i = messages.length - 1; i >= 0; i--) {
			let message = messages[i];
			if (message && (message.type == CONST.CHAT_MESSAGE_TYPES.IC || this._isMessageTypeOOC(message.type))) {
				let lang = message.getFlag("polyglot", "language");
				if (lang) {
					let unknown = !this.isLanguageknownOrUnderstood(lang);
					if (game.user.isGM && !game.settings.get("polyglot", "runifyGM")) {
						// Update globe color
						const globe = this.chatElement.find(`.message[data-message-id="${message.id}"] .message-metadata .polyglot-message-language i`);
						const color = unknown ? "red" : "green";
						globe.css({ color });
						unknown = false;
					}
					if (unknown != message.polyglot_unknown) ui.chat.updateMessage(message);
				}
			}
		}
	}

	getUserLanguages(actors = []) {
		let knownLanguages = new Set();
		let literateLanguages = new Set();
		if (actors.length == 0) {
			if (canvas && canvas.tokens) {
				for (let token of canvas.tokens.controlled) {
					if (token.actor) actors.push(token.actor);
				}
			}
			if (actors.length == 0 && game.user.character) actors.push(game.user.character);
		}
		for (let actor of actors) {
			try {
				[knownLanguages, literateLanguages] = this.languageProvider.getUserLanguages(actor);
			} catch (err) {
				console.error(`Polyglot | Failed to get languages from actor "${actor.name}".`, err);
			}
		}
		return [knownLanguages, literateLanguages];
	}

	/**
	 *
	 * @param {*} html
	 *
	 * @var {Set} this.knownLanguages
	 */
	updateUserLanguages(html) {
		[this.knownLanguages, this.literateLanguages] = this.getUserLanguages();
		const defaultLanguage = this.languageProvider.defaultLanguage;
		if (this.knownLanguages.size == 0) {
			if (game.user.isGM) this.knownLanguages = new Set(Object.keys(this.languageProvider.languages));
			else this.knownLanguages.add(defaultLanguage);
		} else if (this.knownLanguages.has(this.omniglot)) this.knownLanguages = new Set(Object.keys(this.languageProvider.languages));

		let options = "";
		for (let lang of this.knownLanguages) {
			if (!this._isTruespeech(lang) && (lang === this.omniglot || lang === this.comprehendLanguages)) {
				continue;
			}
			const label = this.languageProvider.languages[lang]?.label || lang.capitalize();
			options += `<option value="${lang}">${label}</option>`;
		}

		const select = html.find(".polyglot-lang-select select");
		const prevOption = select.val();
		select.html($(options));

		let selectedLanguage = this.lastSelection || prevOption || defaultLanguage;
		if (!this.isLanguageKnown(selectedLanguage)) {
			if (this.isLanguageKnown(defaultLanguage)) selectedLanguage = defaultLanguage;
			else selectedLanguage = [...this.knownLanguages][0];
		}

		if (game.user.isGM) Polyglot.setLanguageSpeakers(html, selectedLanguage);
		select.val(selectedLanguage);
	}

	/**
	 * Generates a string using alphanumeric characters (0-9a-z)
	 * Use a seeded PRNG (pseudorandom number generator) to get consistent scrambled results.
	 *
	 * @param {string} string	The message's text.
	 * @param {string} salt		The message's id, if Randomize Runes setting is enabled (to make no two messages equal), or its language.
	 * @return {string}			The message's text with its characters scrambled by the PRNG.
	 */
	scrambleString(string, salt, lang) {
		const language = this.languageProvider.languages[lang];
		if (!language) {
			console.warn(`Polyglot | Language "${lang}" doesn't exist on the Language Provider, scrambling has been skipped for this string.`);
			return string;
		}
		const rng = language.rng;
		if (rng == "none") return string;
		if (rng == "default") salt = lang;
		// const font = this._getFontStyle(lang).replace(/\d+%\s/g, "");
		const font = this.languageProvider.getLanguageFont(lang);
		const selectedFont = this.languageProvider.fonts[font];
		if (!selectedFont) {
			console.error(`Invalid font style '${font}'`);
			return string;
		}

		const salted_string = string + salt;
		const seed = new MersenneTwister(this._hashCode(salted_string));
		const regex = game.settings.get("polyglot", "RuneRegex") ? /[a-zA-Z\d]/g : /\S/gu;
		const characters = selectedFont.alphabeticOnly ? "abcdefghijklmnopqrstuvwxyz" : "abcdefghijklmnopqrstuvwxyz0123456789";

		// if (selectedFont.replace) {
		// 	Object.keys(selectedFont.replace).forEach((key) => {
		// 		const replaceRegex = new RegExp(key, "g");
		// 		string = string.replace(replaceRegex, selectedFont.replace[key]);
		// 	});
		// }
		if (selectedFont.logographical) {
			string = string.substring(0, Math.round(string.length / 2));
		}
		return string.replace(regex, () => {
			const c = characters.charAt(Math.floor(seed.random() * characters.length));
			const upper = Boolean(Math.round(seed.random()));
			return upper ? c.toUpperCase() : c;
		});
	}

	/**
	 * Registers settings, adjusts the bubble dimensions so the message is displayed correctly,
	 * and loads the current languages set for Comprehend Languages Spells and Tongues Spell settings.
	 */
	ready() {
		this.updateConfigFonts(game.settings.get("polyglot", "exportFonts"));
		function checkChanges() {
			const alphabetsSetting = game.settings.get("polyglot", "Alphabets");
			const languagesSetting = game.settings.get("polyglot", "Languages");
			const { fonts, languages } = game.polyglot.languageProvider;
			if (!foundry.utils.isEmpty(diffObject(alphabetsSetting, fonts)) || !foundry.utils.isEmpty(diffObject(fonts, alphabetsSetting))) {
				game.settings.set("polyglot", "Alphabets", fonts);
			}
			if (!foundry.utils.isEmpty(diffObject(languagesSetting, languages)) || !foundry.utils.isEmpty(diffObject(languages, languagesSetting))) {
				game.settings.set("polyglot", "Languages", languages);
			}
		}
		if (this.languageProvider.requiresReady) {
			Hooks.once("polyglot.languageProvider.ready", () => {
				this.updateUserLanguages(this.chatElement);
				checkChanges();
			});
		} else checkChanges();
	}

	/* -------------------------------------------- */
	/*  Helpers				                        */
	/* -------------------------------------------- */

	/**
	 * Creates the Header button for the Journal or Journal's Pages.
	 * @param {Document} document 	A JournalSheet or JournalTextPageSheet
	 * @returns {} toggleButton
	 */
	createJournalButton(document) {
		let runes = false;
		let texts = [];
		let styles = [];
		const toggleString = `<a class='polyglot-button'
			data-tooltip='Polyglot: ${game.i18n.localize("POLYGLOT.ToggleRunes")}' data-tooltip-direction="UP">
			<i class='fas fa-unlink'></i>
		</a>`;
		const toggleButton = $(toggleString);
		const IgnoreJournalFontSize = game.settings.get("polyglot", "IgnoreJournalFontSize");
		toggleButton.click((ev) => {
			ev.preventDefault();
			let button = ev.currentTarget.firstChild;
			runes = !runes;
			button.className = runes ? "fas fa-link" : "fas fa-unlink";
			const spans = document.element.find("span.polyglot-journal");
			if (runes) {
				for (let span of spans.toArray()) {
					const lang = span.dataset.language;
					if (!lang) continue;
					texts.push(span.textContent);
					if (span.children.length && span.children[0].nodeName == "SPAN") {
						var spanStyle = {
							fontFamily: span.children[0].style.fontFamily,
							fontSize: span.children[0].style.fontSize,
							font: span.children[0].style.font,
						};
					} else {
						spanStyle = {
							fontFamily: span.style.fontFamily,
							fontSize: span.style.fontSize,
							font: span.style.font,
						};
					}
					styles.push(spanStyle);
					span.textContent = this.scrambleString(span.textContent, document.id, lang);
					if (IgnoreJournalFontSize) span.style.fontFamily = this._getFontStyle(lang).replace(/\d+%\s/g, "");
					else span.style.font = this._getFontStyle(lang);
				}
			} else {
				let i = 0;
				for (let span of spans.toArray()) {
					const lang = span.dataset.language;
					if (!lang) continue;
					span.textContent = texts[i];
					if (styles[i].font) {
						span.style.font = styles[i].font;
					} else {
						span.style.fontFamily = styles[i].fontFamily;
						span.style.fontSize = styles[i].fontSize;
					}
					i++;
				}
				texts = [];
				styles = [];
			}
		});
		return toggleButton;
	}

	/**
	 * Register fonts so they are available to other elements (such as Drawings).
	 */
	updateConfigFonts(value) {
		const coreFonts = game.settings.get("core", "fonts");
		if (value) {
			for (let font in game.polyglot.FONTS) {
				game.polyglot.FONTS[font].editor = true;
			}
			game.settings.set("core", "fonts", { ...coreFonts, ...game.polyglot.FONTS });
		} else {
			for (let font in game.polyglot.FONTS) {
				delete coreFonts[font];
			}
			game.settings.set("core", "fonts", coreFonts);
		}
	}

	isLanguageKnown(lang) {
		return this.knownLanguages.has(lang);
	}

	isLanguageUnderstood(lang) {
		return (
			this.knownLanguages.has(this.omniglot) ||
			this.knownLanguages.has(this.comprehendLanguages) ||
			this.knownLanguages.has(this.truespeech) ||
			this._isOmniglot(lang) ||
			this._isTruespeech(lang)
		);
	}

	/**
	 *
	 * @param {String} lang
	 * @returns {Boolean}
	 */
	isLanguageknownOrUnderstood(lang) {
		return this.isLanguageKnown(lang) || this.isLanguageUnderstood(lang);
	}

	/* -------------------------------------------- */
	/*  Internal Helpers	                        */
	/* -------------------------------------------- */

	_allowOOC() {
		switch (game.settings.get("polyglot", "allowOOC")) {
			case "a":
				return true;
			case "b":
				return game.user.isGM;
			case "c":
				return [CONST.USER_ROLES.TRUSTED, CONST.USER_ROLES.PLAYER].includes(game.user.role);
			default:
				return false;
		}
	}

	/**
	 * Generates a hash based on the input string to be used as a seed.
	 *
	 * @author https://werxltd.com/wp/2010/05/13/javascript-implementation-of-javas-string-hashcode-method/
	 *
	 * @param {string} string 	The salted string.
	 * @returns {int}
	 */
	_hashCode(string) {
		let hash = 0;
		for (let i = 0; i < string.length; i++) {
			const char = string.charCodeAt(i);
			hash = (hash << 5) - hash + char;
			hash = hash & hash;
		}
		return hash;
	}

	/**
	 * Determines if the message content is a link.
	 * @param {String} messageContent
	 * @returns {Boolean} - Whether the message content is a link to an image file or not.
	 */
	_isMessageLink(messageContent) {
		return /@|<|https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&/=]*)$/gi.test(messageContent);
	}

	/**
	 * Checks if a message is Out Of Character.
	 * @param {Number} type
	 * @returns {Boolean}
	 */
	_isMessageTypeOOC(type) {
		return [CONST.CHAT_MESSAGE_TYPES.OOC, CONST.CHAT_MESSAGE_TYPES.WHISPER].includes(type);
	}

	_isOmniglot(lang) {
		return lang == this.omniglot;
	}

	/**
	 * Returns if the language is the target of the Tongues Spell setting.
	 *
	 * @param {string} lang
	 * @returns {Boolean}
	 */
	_isTruespeech(lang) {
		return lang == this.truespeech;
	}

	_onGlobeClick(event) {
		event.preventDefault();
		const li = $(event.currentTarget).parents(".message");
		const message = Messages.instance.get(li.data("messageId"));
		message.polyglot_force = !message.polyglot_force;
		ui.chat.updateMessage(message);
	}

	/**
	 *
	 * @param {string} lang 	A message's polyglot.language flag.
	 * @returns 				The alphabet of the lang or the default alphabet.
	 */
	_getFontStyle(lang) {
		const langFont = this.languageProvider.getLanguageFont(lang);
		const defaultFont = this.languageProvider.defaultFont;
		const font = this.languageProvider.fonts[langFont] || this.languageProvider.fonts[defaultFont];
		return `${font.fontSize}% ${font.fontFamily}`;
	}

	/* -------------------------------------------- */
	/*  Wrappers			                        */
	/* -------------------------------------------- */

	activateEditorWrapper(wrapped, target, editorOptions, initialContent) {
		// let { target, editorOptions, initialContent } = activeEditorLogic(target, editorOptions, initialContent);
		this.activeEditorLogic(editorOptions);
		return wrapped(target, editorOptions, initialContent);
	}

	activeEditorLogic(editorOptions = {}) {
		let langs = this.languageProvider.languages;
		if (!game.user.isGM) {
			langs = {};
			for (let lang of this.knownLanguages) {
				const data = this.languageProvider.languages[lang];
				if (data) {
					langs[lang] = this.languageProvider.languages[lang];
				}
			}
			for (let lang of this.literateLanguages) {
				const data = this.languageProvider.languages[lang];
				if (data) {
					langs[lang] = this.languageProvider.languages[lang];
				}
			}
		}
		const languages = Object.entries(langs)
			.filter(([key]) => typeof langs[key] !== "undefined")
			.map(([key, lang]) => {
				return {
					title: lang.label || "",
					inline: "span",
					classes: "polyglot-journal",
					attributes: {
						title: lang.label || "",
						"data-language": key || "",
					},
				};
			});
		if (this.truespeech) {
			const truespeechIndex = languages.findIndex((element) => element.attributes["data-language"] == this.truespeech);
			if (truespeechIndex !== -1) languages.splice(truespeechIndex, 1);
		}
		if (this.comprehendLanguages && !this._isTruespeech(this.comprehendLanguages)) {
			const comprehendLanguagesIndex = languages.findIndex((element) => element.attributes["data-language"] == this.comprehendLanguages);
			if (comprehendLanguagesIndex !== -1) languages.splice(comprehendLanguagesIndex, 1);
		}
		editorOptions.style_formats = [
			...CONFIG.TinyMCE.style_formats,
			{
				title: "Polyglot",
				items: languages,
			},
		];
		editorOptions.formats = {
			removeformat: [
				// Default remove format configuration from tinyMCE
				{
					selector: "b,strong,em,i,font,u,strike,sub,sup,dfn,code,samp,kbd,var,cite,mark,q,del,ins",
					remove: "all",
					split: true,
					expand: false,
					block_expand: true,
					deep: true,
				},
				{
					selector: "span",
					attributes: ["style", "class"],
					remove: "empty",
					split: true,
					expand: false,
					deep: true,
				},
				{
					selector: "*",
					attributes: ["style", "class"],
					split: false,
					expand: false,
					deep: true,
				},
				// Add custom config to remove spans from polyglot when needed
				{
					selector: "span",
					classes: "polyglot-journal",
					attributes: ["title", "class", "data-language"],
					remove: "all",
					split: true,
					expand: false,
					deep: true,
				},
			],
		};
	}

	static setLanguageSpeakers(html, lang) {
		const speakers = html.find(".polyglot-user-list");
		speakers.empty();

		let playerCharacters = game.actors.filter((actor) => actor.hasPlayerOwner);
		for (let i = 0; i < playerCharacters.length; i++) {
			const knownLanguages = game.polyglot.getUserLanguages([playerCharacters[i]])[0];
			playerCharacters[i].knownLanguages = knownLanguages;
		}
		const usersThatKnowLang = game.users.filter((u) => !u.isGM && playerCharacters.some((a) => a.knownLanguages.has(lang) && a.testUserPermission(u, "OWNER")));

		if (usersThatKnowLang.length) {
			let users = [];
			for (let user of usersThatKnowLang) {
				const { id, name, color } = user;
				let userDiv = $("<div></div>");
				userDiv.attr("data-user-id", id);
				userDiv.attr("data-tooltip", name);
				userDiv.attr("data-tooltip-direction", "UP");
				userDiv.css({ "background-color": color });
				users.push(userDiv);
			}
			speakers.append(...users);
		}
	}

	/* -------------------------------------------- */
	/*  Legacy Support	                            */
	/* -------------------------------------------- */

	get known_languages() {
		return this.knownLanguages;
	}

	get literate_languages() {
		return this.literateLanguages;
	}

	get LanguageProvider() {
		return this.languageProvider;
	}
}
