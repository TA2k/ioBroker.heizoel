"use strict";

/*
 * Created with @iobroker/create-adapter v1.34.1
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const axios = require("axios");

const { extractKeys } = require("./lib/extractKeys");

class Heizoel extends utils.Adapter {
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    constructor(options) {
        super({
            ...options,
            name: "heizoel",
        });
        this.on("ready", this.onReady.bind(this));
        this.on("unload", this.onUnload.bind(this));
    }

    /**
     * Is called when databases are connected and adapter received configuration.
     */
    async onReady() {
        // Reset the connection indicator during startup
        this.setState("info.connection", false, true);
        if (this.config.interval < 30) {
            this.log.info("Configured interval is below the minimum, using 30 minutes.");
            this.config.interval = 30;
        }
        this.updateInterval = null;

        this.requestClient = axios.create({ timeout: 30000 });
        this.extractKeys = extractKeys;

        // Validate configuration once at startup and inform the user with the correct log level.
        if (!this.config.plz) {
            this.log.warn(
                "No zip code (PLZ) is configured. Please enter your PLZ in the adapter settings, otherwise no prices can be retrieved.",
            );
        }
        if (!this.config.esyActive && !this.config.hoDe && !this.config.hoAt) {
            this.log.warn(
                "No price source is enabled. Please activate EsyOil and/or Heizöl24 (DE/AT) in the adapter settings.",
            );
        }

        // EsyOil rejects empty parameters with HTTP 422 ("No offer with these parameters").
        // Fall back to sane defaults for empty fields and warn once, naming the affected field.
        this.esyParams = this.buildEsyParams();

        const amountTrimmed = (this.config.amount || "").replace(/ /g, "");
        this.amountArray = amountTrimmed.split(",").filter((amount) => amount !== "");
        this.amountArray.push("dynamic");

        await this.updatePrice();
        this.updateInterval = setInterval(async () => {
            await this.updatePrice();
        }, this.config.interval * 60 * 1000);
    }

    async updatePrice() {
        if (!this.config.plz) {
            this.log.debug("Skipping price update because no PLZ is configured.");
            this.setState("info.connection", false, true);
            return;
        }

        const tasks = [];
        for (const amount of this.amountArray) {
            if (isNaN(amount) && amount !== "dynamic") {
                this.log.debug(`Ignoring invalid amount "${amount}".`);
                continue;
            }
            if (this.config.esyActive) {
                tasks.push(this.getEsy(amount));
            }
            if (this.config.hoDe) {
                tasks.push(this.getHo24(amount, 1));
            }
            if (this.config.hoAt) {
                tasks.push(this.getHo24(amount, 2));
            }
        }

        if (!tasks.length) {
            return;
        }

        // Only report connected when at least one request in this cycle succeeded.
        const results = await Promise.all(tasks);
        const success = results.some((result) => result === true);
        this.setState("info.connection", success, true);
    }

    /**
     * Builds the EsyOil request parameters, filling empty config fields with
     * defaults. Empty values would otherwise make the API answer with HTTP 422
     * ("No offer with these parameters"). Warns once per empty field.
     * @returns {{payment_type: string, prod: string, hose: string, short_vehicle: string, deliveryTimes: string, unloading_points: number}}
     */
    buildEsyParams() {
        const defaults = {
            payment_type: "ec",
            prod: "normal",
            hose: "fortyMetre",
            short_vehicle: "withTrailer",
            deliveryTimes: "normal",
        };
        const params = {};
        for (const [key, fallback] of Object.entries(defaults)) {
            if (this.config[key]) {
                params[key] = this.config[key];
            } else {
                params[key] = fallback;
                this.log.warn(
                    `EsyOil: option "${key}" is empty, falling back to "${fallback}". ` +
                        "Please open and save the adapter settings to set it explicitly.",
                );
            }
        }
        const unloadingPoints = Number(this.config.unloading_points);
        params.unloading_points = unloadingPoints > 0 ? unloadingPoints : 1;
        return params;
    }

    /**
     * Turns an axios error into a log message with the appropriate level.
     * Transient issues (network, rate limit, server errors) and expected
     * business responses (422 = no offer for these parameters) are warnings,
     * only truly unexpected responses are errors.
     * @param {*} error axios error
     * @param {string} source human readable source incl. amount, e.g. "EsyOil (3000l)"
     * @param {object} [params] the parameters that were actually sent, logged on 422
     */
    handleRequestError(error, source, params) {
        if (!error.response) {
            this.log.warn(`${source}: no response from server (${error.message}). Retrying on next interval.`);
            return;
        }

        const status = error.response.status;
        const message = this.extractApiMessage(error.response.data);

        if (status === 422) {
            this.log.warn(
                `${source}: no offer for the current parameters${message ? ` (${message})` : ""}. ` +
                    "Please check the PLZ, a large enough amount (EsyOil needs at least ~500 l), " +
                    "and that no delivery option is left empty. " +
                    `Sent parameters: ${JSON.stringify(params || {})}`,
            );
            this.log.debug(JSON.stringify(error.response.data));
            return;
        }
        if (status === 429) {
            this.log.warn(`${source}: too many requests (HTTP 429). Consider a larger interval. Retrying later.`);
            return;
        }
        if (status >= 500) {
            this.log.warn(`${source}: server error (HTTP ${status}). Retrying on next interval.`);
            return;
        }

        this.log.error(`${source}: request failed (HTTP ${status})${message ? `: ${message}` : ""}.`);
        this.log.debug(JSON.stringify(error.response.data));
    }

    /**
     * Extracts a readable message from an API error payload.
     * @param {*} data response body
     * @returns {string}
     */
    extractApiMessage(data) {
        if (!data) {
            return "";
        }
        if (typeof data === "string") {
            return data;
        }
        if (Array.isArray(data.message)) {
            return data.message.join(", ");
        }
        if (data.message) {
            return data.message;
        }
        return "";
    }

    async getEsy(amount) {
        let parsedAmount = Number(amount);
        if (amount === "dynamic") {
            const dynamicValueState = await this.getStateAsync("dynamicAmount");
            if (dynamicValueState && dynamicValueState.val) {
                parsedAmount = Number(dynamicValueState.val);
            } else {
                this.log.debug("EsyOil: no dynamicAmount set, skipping dynamic request.");
                return false;
            }
        }
        const requestParams = {
            zipcode: this.config.plz,
            amount: parsedAmount,
            unloading_points: this.esyParams.unloading_points,
            payment_type: this.esyParams.payment_type,
            prod: this.esyParams.prod,
            hose: this.esyParams.hose,
            short_vehicle: this.esyParams.short_vehicle,
            deliveryTimes: this.esyParams.deliveryTimes,
        };
        try {
            const res = await this.requestClient({
                method: "post",
                url: "https://backbone.esyoil.com/heating-oil-calculator/v1/calculate",
                headers: {
                    authority: "backbone.esyoil.com",
                    accept: "application/json, text/plain, */*",
                    "content-type": "application/json",
                    "user-agent":
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.25 Safari/537.36",
                    origin: "https://www.esyoil.com",
                    referer: "https://www.esyoil.com/",
                    "accept-language": "de,en;q=0.9",
                },
                data: JSON.stringify(requestParams),
            });
            if (!res.data) {
                this.log.debug(`EsyOil returned an empty response for ${amount}l.`);
                return false;
            }
            this.log.debug(JSON.stringify(res.data));

            await this.setObjectNotExistsAsync(amount, {
                type: "device",
                common: {
                    name: "Preise für " + amount + "l",
                },
                native: {},
            });
            this.extractKeys(this, amount, res.data);
            return true;
        } catch (error) {
            this.handleRequestError(error, `EsyOil (${amount}l)`, requestParams);
            return false;
        }
    }
    async getHo24(amount, country) {
        let url = "https://www.heizoel24.de/api/kalkulation/berechnen";

        let parsedAmount = Number(amount);
        if (amount === "dynamic") {
            const dynamicValueState = await this.getStateAsync("dynamicAmount");
            if (dynamicValueState && dynamicValueState.val) {
                parsedAmount = Number(dynamicValueState.val);
            } else {
                this.log.debug("Heizöl24: no dynamicAmount set, skipping dynamic request.");
                return false;
            }
        }
        const data = {
            ZipCode: this.config.plz,
            Amount: parsedAmount,
            Stations: Number(this.config.unloading_points),
            Parameters: [
                {
                    Key: "MaxDelivery",
                    Id: 5,
                    Modifier: -1,
                    Name: "maximal",
                    ShortName: null,
                    DisplayName: "max. Lieferfrist",
                    CalculatorName: "siehe Angebot",
                    SubText: null,
                    HasSpecialView: false,
                    IsUpselling: false,
                    BlackList: [],
                    Selected: true,
                    HasSubItems: false,
                    UseIcon: false,
                },
                {
                    Key: null,
                    Id: 24,
                    Modifier: -1,
                    Name: "ganztägig möglich (7-18 Uhr)",
                    ShortName: null,
                    DisplayName: null,
                    CalculatorName: null,
                    SubText: null,
                    HasSpecialView: false,
                    IsUpselling: false,
                    BlackList: [],
                    Selected: true,
                    HasSubItems: false,
                    UseIcon: false,
                },
                {
                    Key: null,
                    Id: -2,
                    Modifier: -1,
                    Name: "alle",
                    ShortName: null,
                    DisplayName: null,
                    CalculatorName: null,
                    SubText: null,
                    HasSpecialView: false,
                    IsUpselling: false,
                    BlackList: [],
                    Selected: true,
                    HasSubItems: false,
                    UseIcon: false,
                },
                {
                    Key: null,
                    Id: 11,
                    Modifier: -1,
                    Name: "mit Hänger",
                    ShortName: "groß",
                    DisplayName: "TKW mit Hänger",
                    CalculatorName: "mit Hänger",
                    SubText: null,
                    HasSpecialView: false,
                    IsUpselling: false,
                    BlackList: [],
                    Selected: true,
                    HasSubItems: false,
                    UseIcon: true,
                },
                {
                    Key: null,
                    Id: 9,
                    Modifier: -1,
                    Name: "bis 40m",
                    ShortName: "40m",
                    DisplayName: null,
                    CalculatorName: null,
                    SubText: null,
                    HasSpecialView: false,
                    IsUpselling: false,
                    BlackList: [],
                    Selected: true,
                    HasSubItems: false,
                    UseIcon: false,
                },
            ],
            CountryId: country,
            Product: { Id: 1, ClimateNeutral: false },
            Cn: false,
            Ap: false,
            AppointmentPlus: false,
            Ordering: 0,
            UpsellCount: 0,
        };
        let source = "Heizöl24 DE";
        if (country === 2) {
            url = "https://www.heizoel24.at/api/kalkulation/berechnen";
            data.Product.Id = 6;
            source = "Heizöl24 AT";
        }
        try {
            const res = await this.requestClient({
                method: "post",
                url: url,
                headers: {
                    accept: "application/json, text/plain, */*",
                    "content-type": "application/json;charset=UTF-8",
                    "user-agent":
                        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.25 Safari/537.36",
                    origin: "https://www.heizoel24.de",
                    "accept-language": "de,en;q=0.9",
                },
                data: data,
            });
            if (!res.data || !res.data.Items) {
                this.log.debug(`${source} (${amount}l): response without offers (Items).`);
                return false;
            }
            this.log.debug(JSON.stringify(res.data));

            await this.setObjectNotExistsAsync("hoe" + amount, {
                type: "device",
                common: {
                    name: "Heizöl24 Preise für " + amount + "l",
                },
                native: {},
            });
            this.extractKeys(this, "hoe" + amount, res.data, null, true);
            return true;
        } catch (error) {
            this.handleRequestError(error, `${source} (${amount}l)`, {
                ZipCode: data.ZipCode,
                Amount: data.Amount,
                Stations: data.Stations,
                CountryId: data.CountryId,
            });
            return false;
        }
    }
    /**
     * Is called when adapter shuts down - callback has to be called under any circumstances!
     * @param {() => void} callback
     */
    onUnload(callback) {
        try {
            clearInterval(this.updateInterval);
            callback();
        } catch (e) {
            this.log.debug("Error during unload: " + e);
            callback();
        }
    }
}

if (require.main !== module) {
    // Export the constructor in compact mode
    /**
     * @param {Partial<utils.AdapterOptions>} [options={}]
     */
    module.exports = (options) => new Heizoel(options);
} else {
    // otherwise start the instance directly
    new Heizoel();
}
