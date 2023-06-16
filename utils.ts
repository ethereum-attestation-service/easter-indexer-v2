import { prisma } from "./db.server";
import { ethers } from "ethers";
import { Attestation } from "@prisma/client";
import dayjs from "dayjs";
import pLimit from "p-limit";
import { Eas__factory } from "./types/ethers-contracts";
import axios from "axios";
import cheerio from "cheerio";
import sharp from "sharp";

const limit = pLimit(5);

export type EASChainConfig = {
  chainId: number;
  chainName: string;
  version: string;
  contractAddress: string;
  schemaRegistryAddress: string;
  etherscanURL: string;
  /** Must contain a trailing dot (unless mainnet). */
  subdomain: string;
  contractStartBlock: number;
  rpcProvider: string;
};

export const CHAIN_ID = Number(process.env.CHAIN_ID);

if (!CHAIN_ID) {
  throw new Error("No chain ID specified");
}

export const EAS_CHAIN_CONFIGS: EASChainConfig[] = [
  {
    chainId: 11155111,
    chainName: "sepolia",
    subdomain: "",
    version: "0.26",
    contractAddress: "0xC2679fBD37d54388Ce493F1DB75320D236e1815e",
    schemaRegistryAddress: "0x0a7E2Ff54e76B8E6659aedc9103FB21c038050D0",
    etherscanURL: "https://sepolia.etherscan.io",
    contractStartBlock: 2958570,
    rpcProvider: `https://eth-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_SEPOLIA_API_KEY}`,
  },
  {
    chainId: 42161,
    chainName: "arbitrum",
    subdomain: "arbitrum.",
    version: "0.26",
    contractAddress: "0xbD75f629A22Dc1ceD33dDA0b68c546A1c035c458",
    schemaRegistryAddress: "0xA310da9c5B885E7fb3fbA9D66E9Ba6Df512b78eB",
    contractStartBlock: 64528380,
    etherscanURL: "https://arbiscan.io",
    rpcProvider: `https://arbitrum-mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
  },
  {
    chainId: 1,
    chainName: "mainnet",
    subdomain: "",
    version: "0.26",
    contractAddress: "0xA1207F3BBa224E2c9c3c6D5aF63D0eb1582Ce587",
    schemaRegistryAddress: "0xA7b39296258348C78294F95B872b282326A97BDF",
    contractStartBlock: 16756720,
    etherscanURL: "https://etherscan.io",
    rpcProvider: `https://mainnet.infura.io/v3/${process.env.INFURA_API_KEY}`,
  },
  {
    chainId: 420,
    chainName: "optimism-goerli",
    subdomain: "optimism-goerli.",
    version: "0.27",
    contractAddress: "0x1a5650D0EcbCa349DD84bAFa85790E3e6955eb84",
    schemaRegistryAddress: "0x7b24C7f8AF365B4E308b6acb0A7dfc85d034Cb3f",
    contractStartBlock: 8513369,
    etherscanURL: "https://goerli-optimism.etherscan.io/",
    rpcProvider: `https://opt-goerli.g.alchemy.com/v2/${process.env.ALCHEMY_OPTIMISM_GOERLI_API_KEY}`,
  },
  {
    chainId: 84531,
    chainName: "base-goerli",
    subdomain: "base-goerli.",
    version: "0.27",
    contractAddress: "0xAcfE09Fd03f7812F022FBf636700AdEA18Fd2A7A",
    schemaRegistryAddress: "0x720c2bA66D19A725143FBf5fDC5b4ADA2742682E",
    contractStartBlock: 4843430,
    etherscanURL: "https://goerli.basescan.org/",
    rpcProvider: `https://goerli.base.org`,
  },
];

const activeChainConfig = EAS_CHAIN_CONFIGS.find(
  (config) => config.chainId === CHAIN_ID
);

if (!activeChainConfig) {
  throw new Error("No chain config found for chain ID");
}

export const EASContractAddress = activeChainConfig.contractAddress;
export const CONTRACT_START_BLOCK = activeChainConfig.contractStartBlock;
export const revokedEventSignature = "Revoked(address,address,bytes32,bytes32)";
export const attestedEventSignature =
  "Attested(address,address,bytes32,bytes32)";

export const makePostUID =
  "0xbbea47804168571b26f0ea2962bfbd1b11184bc0a438724c890151201eb60128";
export const likeUID =
  "0x33e9094830a5cba5554d1954310e4fbed2ef5f859ec1404619adea4207f391fd";
export const usernameUID =
  "0x1c12bac4f230477c87449a101f5f9d6ca1c492866355c0a5e27026753e5ebf40";
export const followUID =
  "0x4915a98a3dc10c71027c01e59cb39415d4c04fdcdde539d6d04fc812af86d8dd";

export const provider = new ethers.providers.StaticJsonRpcProvider(
  activeChainConfig.rpcProvider,
  activeChainConfig.chainId
);

const easContract = Eas__factory.connect(EASContractAddress, provider);

// Timeout Promise
function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function getFormattedAttestationFromLog(
  log: ethers.providers.Log
): Promise<Attestation> {
  let UID = ethers.constants.HashZero;
  let schemaUID = ethers.constants.HashZero;
  let refUID = ethers.constants.HashZero;
  let time = ethers.BigNumber.from(0);
  let expirationTime = ethers.BigNumber.from(0);
  let revocationTime = ethers.BigNumber.from(0);
  let recipient = ethers.constants.AddressZero;
  let attester = ethers.constants.AddressZero;
  let revocable = false;
  let data = "";

  let tries = 1;

  do {
    [
      UID,
      schemaUID,
      time,
      expirationTime,
      revocationTime,
      refUID,
      recipient,
      attester,
      revocable,
      data,
    ] = await easContract.getAttestation(log.data);

    if (UID === ethers.constants.HashZero) {
      console.log(`Delaying attestation poll after try #${tries}...`);
      await timeout(500);
    }

    tries++;
  } while (UID === ethers.constants.HashZero);

  return {
    id: UID,
    schemaId: schemaUID,
    data,
    attester,
    recipient,
    refUID: refUID,
    revocationTime: revocationTime.toNumber(),
    expirationTime: expirationTime.toNumber(),
    time: time.toNumber(),
    txid: log.transactionHash,
    revoked: revocationTime.lt(dayjs().unix()) && !revocationTime.isZero(),
    isOffchain: false,
    ipfsHash: "",
    timeCreated: dayjs().unix(),
    revocable,
  };
}

export async function revokeAttestationsFromLogs(logs: ethers.providers.Log[]) {
  for (let log of logs) {
    const attestation = await easContract.getAttestation(log.data);

    if (attestation.schema === makePostUID) {
      await prisma.post.updateMany({
        where: { id: attestation.uid },
        data: {
          revokedAt: attestation.revocationTime.toNumber(),
        },
      });
    } else if (attestation.schema === likeUID) {
      await prisma.like.updateMany({
        where: { id: attestation.uid },
        data: {
          revokedAt: attestation.revocationTime.toNumber(),
        },
      });
    } else if (attestation.schema === followUID) {
      await prisma.follow.updateMany({
        where: { id: attestation.uid },
        data: {
          revokedAt: attestation.revocationTime.toNumber(),
        },
      });
    }
  }
}

export async function parseAttestationLogs(logs: ethers.providers.Log[]) {
  const promises = logs.map((log) =>
    limit(() => getFormattedAttestationFromLog(log))
  );

  const attestations = await Promise.all(promises);

  for (let attestation of attestations) {
    await processCreatedAttestation(attestation);
  }
}

async function processPostAttestation(attestation: Attestation) {
  try {
    const decodedStatementAttestationData = ethers.utils.defaultAbiCoder.decode(
      ["string"],
      attestation.data
    );

    let parentId: null | string = null;

    if (attestation.refUID !== ethers.constants.HashZero) {
      const parentPost = await prisma.post.findUnique({
        where: { id: attestation.refUID },
      });

      if (parentPost) {
        parentId = parentPost.id;
      }
    }

    const newPost = await prisma.post.create({
      data: {
        userId: attestation.attester,
        createdAt: attestation.time,
        recipientId: attestation.recipient,
        content: decodedStatementAttestationData[0],
        id: attestation.id,
        parentId,
        revokedAt: 0,
      },
    });

    const urls = extractURLs(decodedStatementAttestationData[0]);

    if (urls.length > 0) {
      console.log("Fetching link preview for", urls[0]);
      try {
        const preview = await fetchMetaTags(urls[0]);

        if (preview.image) {
          console.log("Downloading image for", urls[0]);
          const imageRes = await axios.get(preview.image, {
            responseType: "arraybuffer",
          });

          console.log("Resizing image for", urls[0]);
          await sharp(imageRes.data)
            .resize(1000, null, { withoutEnlargement: true })
            .jpeg()
            .toFile(`./uploads/url_previews/${newPost.id}.jpg`);
        }

        if (preview.title) {
          console.log("Creating link preview for", urls[0]);
          await prisma.linkPreview.create({
            data: {
              postId: newPost.id,
              title: preview.title,
              description: preview.description ?? ``,
              image: preview.image ? `${newPost.id}.jpg` : "",
              url: urls[0],
              createdAt: attestation.time,
            },
          });
        }
      } catch (e) {
        console.log("Error: Unable to fetch link preview", e);
      }
    }
  } catch (e) {
    console.log("Error: Unable to decode schema name", e);
    return;
  }
}

export async function processCreatedAttestation(
  attestation: Attestation
): Promise<void> {
  const attestingUser = await prisma.user.findUnique({
    where: { id: attestation.attester },
  });

  const schemasToProcess = [makePostUID, likeUID, followUID, usernameUID];

  if (!attestingUser && schemasToProcess.includes(attestation.schemaId)) {
    console.log("Creating new user", attestation.attester);

    await prisma.user.create({
      data: {
        id: attestation.attester,
        name: "",
        createdAt: attestation.time,
      },
    });
  }

  const recipientUser = await prisma.user.findUnique({
    where: { id: attestation.recipient },
  });

  if (!recipientUser && schemasToProcess.includes(attestation.schemaId)) {
    console.log("Creating new user", attestation.recipient);

    await prisma.user.create({
      data: {
        id: attestation.recipient,
        name: "",
        createdAt: attestation.time,
      },
    });
  }

  if (attestation.schemaId === likeUID) {
    try {
      const postToLike = await prisma.post.findUnique({
        where: { id: attestation.refUID },
      });

      if (postToLike) {
        console.log("Creating new like", attestation.id);
        await prisma.like.create({
          data: {
            id: attestation.id,
            postId: attestation.refUID,
            userId: attestation.attester,
            createdAt: attestation.time,
            revokedAt: 0,
          },
        });
      }
    } catch (error) {
      console.log("Error processing like attestation", error);
    }
  } else if (attestation.schemaId === makePostUID) {
    await processPostAttestation(attestation);
  } else if (attestation.schemaId === usernameUID) {
    try {
      const decodedUsernameAttestationData =
        ethers.utils.defaultAbiCoder.decode(["bytes32"], attestation.data);

      await prisma.user.update({
        where: { id: attestation.attester },
        data: {
          name: ethers.utils.parseBytes32String(
            decodedUsernameAttestationData[0]
          ),
        },
      });
    } catch (e) {
      console.log("Error: Unable to decode schema name", e);
      return;
    }
  } else if (attestation.schemaId === followUID) {
    try {
      await prisma.follow.create({
        data: {
          id: attestation.id,
          followerId: attestation.attester,
          followingId: attestation.recipient,
          createdAt: attestation.time,
          revokedAt: 0,
        },
      });
    } catch (e) {
      console.log("Error: Unable to decode schema name", e);
      return;
    }
  }
}

export async function getAndUpdateLatestAttestationRevocations() {
  const serviceStatPropertyName = "latestAttestationRevocationBlockNum";

  const { latestBlockNumServiceStat, fromBlock } = await getStartData(
    serviceStatPropertyName
  );

  console.log(`Attestation revocation update starting from block ${fromBlock}`);

  const logs = await provider.getLogs({
    address: EASContractAddress,
    fromBlock: fromBlock + 1,
    topics: [
      ethers.utils.id(revokedEventSignature),
      null,
      null,
      [makePostUID, likeUID, followUID],
    ],
  });

  await revokeAttestationsFromLogs(logs);

  const lastBlock = getLastBlockNumberFromLog(logs);

  await updateServiceStatToLastBlock(
    !latestBlockNumServiceStat,
    serviceStatPropertyName,
    lastBlock
  );

  console.log(`New Attestation Revocations: ${logs.length}`);
}

export async function updateServiceStatToLastBlock(
  shouldCreate: boolean,
  serviceStatPropertyName: string,
  lastBlock: number
) {
  if (shouldCreate) {
    await prisma.serviceStat.create({
      data: { name: serviceStatPropertyName, value: lastBlock.toString() },
    });
  } else {
    if (lastBlock !== 0) {
      await prisma.serviceStat.update({
        where: { name: serviceStatPropertyName },
        data: { value: lastBlock.toString() },
      });
    }
  }
}

export async function getAndUpdateLatestAttestations() {
  const serviceStatPropertyName = "latestAttestationBlockNum";

  const { latestBlockNumServiceStat, fromBlock } = await getStartData(
    serviceStatPropertyName
  );

  console.log(`Attestation update starting from block ${fromBlock}`);

  const logs = await provider.getLogs({
    address: EASContractAddress,
    fromBlock: fromBlock + 1,
    topics: [
      ethers.utils.id(attestedEventSignature),
      null,
      null,
      [makePostUID, likeUID, usernameUID, followUID],
    ],
  });

  await parseAttestationLogs(logs);

  const lastBlock = getLastBlockNumberFromLog(logs);

  await updateServiceStatToLastBlock(
    !latestBlockNumServiceStat,
    serviceStatPropertyName,
    lastBlock
  );

  console.log(`New Attestations: ${logs.length}`);
}

async function getStartData(serviceStatPropertyName: string) {
  const latestBlockNumServiceStat = await prisma.serviceStat.findFirst({
    where: { name: serviceStatPropertyName },
  });

  let fromBlock: number = CONTRACT_START_BLOCK;

  if (latestBlockNumServiceStat?.value) {
    fromBlock = Number(latestBlockNumServiceStat.value);
  }

  if (fromBlock === 0) {
    fromBlock = CONTRACT_START_BLOCK;
  }

  return { latestBlockNumServiceStat, fromBlock };
}

export function getLastBlockNumberFromLog(logs: ethers.providers.Log[]) {
  return logs.length ? logs[logs.length - 1].blockNumber : 0;
}

export async function updateDbFromRelevantLog(log: ethers.providers.Log) {
  if (log.address === EASContractAddress) {
    if (
      log.topics[0] === ethers.utils.id(attestedEventSignature) &&
      [makePostUID, likeUID, usernameUID, followUID].includes(log.topics[3])
    ) {
      await parseAttestationLogs([log]);
      await updateServiceStatToLastBlock(
        false,
        "latestAttestationBlockNum",
        log.blockNumber
      );
    } else if (
      log.topics[0] === ethers.utils.id(revokedEventSignature) &&
      [makePostUID, likeUID, followUID].includes(log.topics[3])
    ) {
      await revokeAttestationsFromLogs([log]);
      await updateServiceStatToLastBlock(
        false,
        "latestAttestationRevocationBlockNum",
        log.blockNumber
      );
    }
  }
}

function extractURLs(text: string): string[] {
  const urlRegex =
    /[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)/g;
  const urls = text
    .match(urlRegex)
    ?.map((url) => `https://${url}`)
    .filter((url) => !url.includes("@"));
  return urls || [];
}

const fetchMetaTags = async (url: string) => {
  const res = await axios.get(url);
  const html = await res.data;
  const $ = cheerio.load(html);
  const getMetaTag = (name: string) =>
    $(`meta[name=${name}]`).attr("content") ||
    $(`meta[name="og:${name}"]`).attr("content") ||
    $(`meta[property="og:${name}"]`).attr("content") ||
    $(`meta[name="twitter:${name}"]`).attr("content") ||
    $(`meta[property="twitter:${name}"]`).attr("content");

  return {
    url,
    title: $("title").first().text(),
    favicon: $('link[rel="shortcut icon"]').attr("href"),
    // Add here all the meta tags you need
    description: getMetaTag("description"),
    image: getMetaTag("image"),
    author: getMetaTag("author"),
  };
};

export async function updatePostMetaData(postId: string) {
  try {
    const post = await prisma.post.findUnique({
      where: { id: postId },
    });

    if (!post) {
      return;
    }

    const urls = extractURLs(post.content);

    if (urls.length > 0) {
      console.log("Fetching link preview for", urls[0]);
      try {
        const preview = await fetchMetaTags(urls[0]);

        if (preview.image) {
          console.log("Downloading image for", urls[0]);
          const imageRes = await axios.get(preview.image, {
            responseType: "arraybuffer",
          });

          console.log("Resizing image for", urls[0]);
          await sharp(imageRes.data)
            .resize(1000, null, { withoutEnlargement: true })
            .jpeg()
            .toFile(`./uploads/url_previews/${post.id}.jpg`);
        }

        if (preview.title) {
          console.log("Creating link preview for", urls[0]);
          await prisma.linkPreview.upsert({
            where: { postId: post.id },
            update: {
              title: preview.title,
              description: preview.description ?? ``,
              image: preview.image ? `${post.id}.jpg` : "",
              url: urls[0],
              createdAt: post.createdAt,
            },
            create: {
              postId: post.id,
              title: preview.title,
              description: preview.description ?? ``,
              image: preview.image ? `${post.id}.jpg` : "",
              url: urls[0],
              createdAt: post.createdAt,
            },
          });
        }
      } catch (e) {
        console.log("Error: Unable to fetch link preview", e);
      }
    }
  } catch (e) {
    console.log("Error: Unable to decode schema name", e);
    return;
  }
}
