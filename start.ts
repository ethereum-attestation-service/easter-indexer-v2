import { ethers } from "ethers";
import {
  attestedEventSignature,
  getAndUpdateLatestAttestationRevocations,
  getAndUpdateLatestAttestations,
  provider,
  revokedEventSignature,
  updateDbFromRelevantLog,
  updatePostMetaData,
} from "./utils";
import { startGraph } from "./graph";
import express from "express";
require("dotenv").config();

const app = express();

app.use("/url_previews/uploads", express.static("uploads"));

app.get("/url_previews/updateMeta/:postId", async (req, res) => {
  const postId = req.params.postId;

  await updatePostMetaData(postId);

  res.send("ok");
});

app.listen(6231, () => {
  console.log("Listening on port 6231");
});

let running = false;

export async function update() {
  if (running) {
    return;
  }

  try {
    running = true;
    await getAndUpdateLatestAttestations();
    await getAndUpdateLatestAttestationRevocations();
  } catch (e) {
    console.log("Error!", e);
  }
  running = false;
}

async function go() {
  await update();

  const filter = {
    topics: [
      [
        ethers.utils.id(attestedEventSignature),
        ethers.utils.id(revokedEventSignature),
      ],
    ],
  };

  provider.on(filter, async (log: ethers.providers.Log) => {
    await updateDbFromRelevantLog(log);
  });
}

go();
startGraph();
