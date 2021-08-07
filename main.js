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
            if (this.config.esyActive) {
                await this.getEsy(amount);
            }
            if (this.config.hoDe) {
                await this.getHo24(amount, 1);
            }
            if (this.config.hoAt) {
                await this.getHo24(amount, 2);
            }
        });
    }

    async getEsy(amount) {
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
                        name: "Preise für " + amount + "l",
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
    }
    async getHo24(amount, country) {
        const parsedAmount = Number(amount);
        const data = {
            ZipCode: this.config.plz,
            Amount: amount,
            Stations: this.config.unloading_points,
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
        await this.requestClient({
            method: "post",
            url: "https://www.heizoel24.de/api/kalkulation/berechnen",
            headers: {
                authority: "www.heizoel24.de",
                accept: "application/json, text/plain, */*",
                "content-type": "application/json;charset=UTF-8",
                "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/93.0.4577.25 Safari/537.36",
                origin: "https://www.heizoel24.de",
                "accept-language": "de,en;q=0.9",
            },
            data: JSON.stringify(data),
        })
            .then(async (res) => {
                this.log.debug(JSON.stringify(res.data));
                if (!res.data || !res.data.Items) {
                    return;
                }

                this.setState("info.connection", true, true);
                await this.setObjectNotExistsAsync("ho24" + amount, {
                    type: "device",
                    common: {
                        name: "Heizöl24 Preise für " + amount + "l",
                    },
                    native: {},
                });
                this.extractKeys(this, "ho24" + amount, res.data.Items);
            })
            .catch((error) => {
                this.setState("info.connection", false, true);
                this.log.error(error);
                error.response && this.log.debug(JSON.stringify(error.response.data));
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
