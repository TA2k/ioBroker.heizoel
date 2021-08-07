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
        if (this.config.interval < 0.5) {
            this.log.info("Set interval to minimum 0.5");
            this.config.interval = 0.5;
        }
        this.updateInterval = null;

        this.requestClient = axios.create();
        this.extractKeys = extractKeys;
        const amountTrimmed = this.config.amount.replace(/ /g, "");
        this.amountArray = amountTrimmed.split(",");

        await this.updatePrice();
        this.updateInterval = setInterval(async () => {
            await this.updatePrice();
        }, this.config.interval * 60 * 1000);
    }

    async updatePrice() {
        this.amountArray.forEach(async (amount) => {
            if (isNaN(amount)) {
                return;
            }
            const parsedAmount = Number(amount);
            await this.requestClient({
                method: "post",
                url: "https://backbone.esyoil.com/heating-oil-calculator/v1/calculate",
                headers: {
                    authority: "backbone.esyoil.com",
                    accept: "application/json, text/plain, */*",
                    "content-type": "application/json",
                    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.25 Safari/537.36",
                    origin: "https://www.esyoil.com",
                    referer: "https://www.esyoil.com/",
                    "accept-language": "de,en;q=0.9",
                },
                data: JSON.stringify({
                    zipcode: this.config.plz,
                    amount: parsedAmount,
                    unloading_points: Number(this.config.unloading_points),
                    payment_type: this.config.payment_type,
                    prod: this.config.prod,
                    hose: this.config.hose,
                    short_vehicle: this.config.short_vehicle,
                    deliveryTimes: this.config.deliveryTimes,
                }),
            })
                .then(async (res) => {
                    this.log.debug(JSON.stringify(res.data));
                    if (!res.data) {
                        return;
                    }

                    this.setState("info.connection", true, true);
                    await this.setObjectNotExistsAsync(amount, {
                        type: "device",
                        common: {
                            name: "Preise für " + amount,
                        },
                        native: {},
                    });
                    this.extractKeys(this, amount, res.data);
                })
                .catch((error) => {
                    this.setState("info.connection", false, true);
                    this.log.error(error);
                    error.response && this.log.debug(JSON.stringify(error.response.data));
                });
        });
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
