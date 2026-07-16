const https = require("https");

function findSubdomains(domain) {

    const url = `https://crt.sh/?q=%25.${domain}&output=json`;

    https.get(url, (response) => {

        let data = "";

        response.on("data", chunk => {
            data += chunk;
        });
        response.on("end", () => {

            let results = JSON.parse(data);

            let subdomains = new Set();

            results.forEach(item => {
                item.name_value.split("\n").forEach(sub => {
                    subdomains.add(sub);
                });
            });

            console.log("\nSubdomains Found:\n");

            subdomains.forEach(sub => {
                console.log(sub);
            });

        });

    }).on("error", err => {
        console.log("Error:", err.message);
    });
}


// Enter target domain here
findSubdomains("example.com");