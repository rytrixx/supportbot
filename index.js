/**
 * index.js - Uitgebreide Ticket Bot (discord.js v14)
 *
 * Features:
 * - 17 Nederlandse categorieën (zie CATEGORIES)
 * - Category per gekozen categorie (ticket channels placed under that category)
 * - Channel name format: <categorie-normalized>-<username-normalized>-<nickname-normalized-if-different>
 * - All bot messages are embeds
 * - Modal for optional short topic
 * - Buttons: Claim / Unclaim / Close / Transcript
 * - On Close: shows embed "closing in 5s", waits 5 seconds, builds transcript, sends to staff log and DM owner, then deletes channel
 * - SQLite (better-sqlite3) persistence
 *
 * Edit the PANEL_IMAGE_PATH variable if you want another image.
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  AttachmentBuilder
} = require('discord.js');

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID || null;
const STAFF_ROLE_NAME = process.env.STAFF_ROLE_NAME || 'Staff';
const STAFF_LOG_CHANNEL_ID = process.env.STAFF_LOG_CHANNEL_ID || null;

if (!TOKEN || !CLIENT_ID) {
  console.error('Please set DISCORD_TOKEN and CLIENT_ID in .env');
  process.exit(1);
}

// Ensure transcripts folder
if (!fs.existsSync('./transcripts')) fs.mkdirSync('./transcripts');

// DB init
const db = new Database(path.join(__dirname, 'tickets.sqlite'));
db.pragma('journal_mode = WAL');
db.prepare(`
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    claimed_by TEXT,
    status TEXT NOT NULL,
    category TEXT,
    topic TEXT,
    created_at INTEGER NOT NULL
  )
`).run();

// CATEGORIES (17, from your screenshot)
const CATEGORIES = [
  'Unban Aanvraag Anti Cheat',
  'Unban Aanvraag Discord',
  'Unban Aanvraag Ingame',
  'Klachten Over Spelers',
  'Klachten Over Staff',
  'Ingame Refunds',
  'Pc Checks',
  'Overige Vragen',
  'Content Creator Coördinator',
  'Hulpdiensten Coördinator',
  'Onderwereld Coördinator',
  'Development',
  'Car Development',
  'Headstaff',
  'Bestuur',
  "Staff Sollicitatie's",
  'Donaties'
];

// local panel image (from your uploaded file)
const PANEL_IMAGE_PATH = '/mnt/data/b2e369ed-4739-4fb8-a46b-eff71c93c3a3.png';
const PANEL_IMAGE_EXISTS = fs.existsSync(PANEL_IMAGE_PATH);

// map to hold pending user -> category while modal is shown
const pendingCategoryForUser = new Map();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel, Partials.Message, Partials.Reaction]
});

// ---------- Helpers ----------
function normalizeForName(s) {
  if (!s) return '';
  return String(s).toLowerCase()
    .replace(/[^a-z0-9\s-_]/g, '') // remove special chars
    .trim()
    .replace(/\s+/g, '-'); // spaces -> dash
}

function isStaff(member) {
  if (!member) return false;
  if (member.permissions && member.permissions.has && member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  return !!member.roles?.cache?.some(r => r.name === STAFF_ROLE_NAME);
}

async function getOrCreateCategoryByName(guild, name) {
  let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === name);
  if (!category) {
    try {
      category = await guild.channels.create({ name, type: ChannelType.GuildCategory });
    } catch (err) {
      console.error('Failed to create category', err);
      return null;
    }
  }
  return category;
}

function insertTicketRow(guildId, channelId, ownerId, cat, topic) {
  const now = Date.now();
  const stmt = db.prepare(`INSERT INTO tickets (guild_id, channel_id, owner_id, claimed_by, status, category, topic, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const info = stmt.run(guildId, channelId, ownerId, null, 'open', cat, topic || null, now);
  return info.lastInsertRowid;
}

function getTicketById(id) {
  return db.prepare('SELECT * FROM tickets WHERE id = ?').get(id);
}
function getTicketByChannel(channelId) {
  return db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(channelId);
}
function updateTicketClaim(id, userId) {
  db.prepare('UPDATE tickets SET claimed_by = ? WHERE id = ?').run(userId, id);
}
function unclaimTicket(id) {
  db.prepare('UPDATE tickets SET claimed_by = NULL WHERE id = ?').run(id);
}
function closeTicketRow(id) {
  db.prepare('UPDATE tickets SET status = ? WHERE id = ?').run('closed', id);
}

// ---------- UI Builders ----------
function buildCategoryDropdown() {
  const options = CATEGORIES.map((c, i) => ({
    label: c.length > 100 ? c.slice(0, 97) + '...' : c,
    value: String(i)
  }));
  const menu = new StringSelectMenuBuilder()
    .setCustomId('ticket_category_select')
    .setPlaceholder('Kies een categorie...')
    .addOptions(options)
    .setMinValues(1)
    .setMaxValues(1);
  return new ActionRowBuilder().addComponents(menu);
}

function buildTicketControlRow(ticketId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`claim_${ticketId}`).setLabel('Claim').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`unclaim_${ticketId}`).setLabel('Unclaim').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`close_${ticketId}`).setLabel('Close').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`transcript_${ticketId}`).setLabel('Transcript').setStyle(ButtonStyle.Secondary)
  );
}

function embedInfo(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0x5865F2).setTimestamp();
}
function embedSuccess(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0x57F287).setTimestamp();
}
function embedError(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xED4245).setTimestamp();
}
function embedAction(title, desc) {
  return new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xFEE75C).setTimestamp();
}

// ---------- Commands Registration ----------
const { REST } = require('@discordjs/rest');
const { Routes } = require('discord-api-types/v10');

const commandData = [
  { name: 'setup-ticket-panel', description: 'Plaats of update het ticket panel (dropdown).' },
  {
    name: 'claim', description: 'Claim het ticket (staff).',
    options: [{ name: 'channel', type: 7, description: 'Ticket kanaal (laat leeg = huidig)', required: false }]
  },
  {
    name: 'unclaim', description: 'Unclaim het ticket (staff).',
    options: [{ name: 'channel', type: 7, description: 'Ticket kanaal (laat leeg = huidig)', required: false }]
  },
  {
    name: 'close', description: 'Sluit het ticket (staff).',
    options: [{ name: 'channel', type: 7, description: 'Ticket kanaal (laat leeg = huidig)', required: false }]
  },
  {
    name: 'transcript', description: 'Maak transcript van ticket (staff).',
    options: [{ name: 'channel', type: 7, description: 'Ticket kanaal (laat leeg = huidig)', required: false }]
  },
  { name: 'rename', description: 'Hernoem ticket kanaal (staff).', options: [{ name: 'name', type: 3, description: 'Nieuwe kanaalnaam', required: true }] },
  { name: 'add', description: 'Voeg gebruiker toe aan ticket (staff).', options: [{ name: 'user', type: 6, description: 'Gebruiker', required: true }] },
  { name: 'remove', description: 'Verwijder gebruiker uit ticket (staff).', options: [{ name: 'user', type: 6, description: 'Gebruiker', required: true }] }
];

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    if (GUILD_ID) {
      console.log('Registering guild commands...');
      await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commandData });
      console.log('Registered (guild) commands.');
    } else {
      console.log('Registering global commands (may take up to 1 hour)...');
      await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commandData });
      console.log('Registered global commands.');
    }
  } catch (err) {
    console.error('Command registration error:', err);
  }
}

// ---------- Ticket creation flow ----------
async function createTicketChannelFromChoice(guild, user, categoryIndex, topic) {
  const categoryName = CATEGORIES[categoryIndex] || 'Overige Vragen';
  const parent = await getOrCreateCategoryByName(guild, categoryName);
  if (!parent) throw new Error('Category create/fetch failed.');

  // channel name: category-normalized + username + nickname (if different)
  const username = normalizeForName(user.username || user.tag || 'user');
  let nickname = '';
  try {
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (member && member.nickname) nickname = normalizeForName(member.nickname);
  } catch (err) { /* ignore */ }

  let channelBase = normalizeForName(categoryName);
  channelBase += `-${username}`;
  if (nickname && nickname !== username) channelBase += `-${nickname}`;

  // ensure uniqueness
  let channelName = channelBase;
  let suffix = 1;
  while (guild.channels.cache.some(ch => ch.name === channelName)) {
    channelName = `${channelBase}-${suffix++}`;
  }

  // permissions: hide for @everyone, allow owner, allow staff role
  const everyonePerm = { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] };
  const ownerPerm = { id: user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory] };

  const created = await guild.channels.create({
    name: channelName,
    type: ChannelType.GuildText,
    parent: parent.id,
    permissionOverwrites: [everyonePerm, ownerPerm]
  });

  // apply staff role perms
  const staffRole = guild.roles.cache.find(r => r.name === STAFF_ROLE_NAME);
  if (staffRole) {
    await created.permissionOverwrites.create(staffRole, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true }).catch(() => {});
  }

  // db insert
  const ticketId = insertTicketRow(guild.id, created.id, user.id, categoryName, topic || null);

  const embed = new EmbedBuilder()
    .setTitle(`Nieuw ticket — ${categoryName}`)
    .setDescription(`Hallo ${user}, bedankt! Een teamlid zal je helpen.\n**Onderwerp:** ${topic || 'Niet opgegeven'}`)
    .setFooter({ text: `Ticket ID: ${ticketId}` })
    .setTimestamp()
    .setColor(0x5865F2);

  const controlRow = buildTicketControlRow(ticketId);
  await created.send({ content: `<@${user.id}>`, embeds: [embed], components: [controlRow] });

  // staff log (optional)
  if (STAFF_LOG_CHANNEL_ID) {
    const logCh = guild.channels.cache.get(STAFF_LOG_CHANNEL_ID) || await guild.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(() => null);
    if (logCh) {
      const logEmbed = embedInfo('Nieuw ticket geopend', `Ticket ${created} geopend door <@${user.id}> — ${categoryName}`);
      await logCh.send({ embeds: [logEmbed] }).catch(() => {});
    }
  }

  return { channel: created, ticketId };
}

// ---------- Transcript ----------
async function makeTranscript(channel) {
    // Gebruik lokale map
    const transcriptsDir = path.join(__dirname, "transcripts");

    // Map automatisch aanmaken
    if (!fs.existsSync(transcriptsDir)) {
        fs.mkdirSync(transcriptsDir);
    }

    let messages = [];
    let lastId = null;

    while (true) {
        const options = { limit: 100 };
        if (lastId) options.before = lastId;

        const fetched = await channel.messages.fetch(options);
        if (fetched.size === 0) break;

        messages = messages.concat(Array.from(fetched.values()));
        lastId = fetched.last().id;

        if (fetched.size < 100) break;
    }

    messages = messages.reverse();

    let transcriptText = `Transcript van #${channel.name}\n\n`;

    for (const msg of messages) {
        const time = msg.createdAt.toISOString();
        const author = msg.author?.tag || "Onbekend";
        const content = msg.content || "";
        transcriptText += `[${time}] ${author}: ${content}\n`;

        if (msg.attachments.size > 0) {
            msg.attachments.forEach(att => {
                transcriptText += `    📎 Attachment: ${att.url}\n`;
            });
        }
    }

    const filePath = path.join(transcriptsDir, `${channel.id}-transcript.txt`);
    fs.writeFileSync(filePath, transcriptText, "utf8");

    return filePath;
}

// ---------- Interaction Handling ----------
client.on('interactionCreate', async (interaction) => {
  try {
    // SELECT MENU
    if (interaction.isStringSelectMenu() && interaction.customId === 'ticket_category_select') {
      const chosen = interaction.values[0];
      pendingCategoryForUser.set(interaction.user.id, chosen);

      const modal = new ModalBuilder().setCustomId('ticket_topic_modal').setTitle('Open een Ticket');
      const topicInput = new TextInputBuilder()
        .setCustomId('topic_input')
        .setLabel('Kort onderwerp (optioneel)')
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setPlaceholder('Bijv. Ban appeal, Bug, Refund...');
      modal.addComponents(new ActionRowBuilder().addComponents(topicInput));
      await interaction.showModal(modal);
      return;
    }

    // MODAL SUBMIT
    if (interaction.isModalSubmit() && interaction.customId === 'ticket_topic_modal') {
      const userId = interaction.user.id;
      const chosen = pendingCategoryForUser.get(userId);
      pendingCategoryForUser.delete(userId);
      if (!chosen) {
        return interaction.reply({ embeds: [embedError('Fout', 'Categorie niet gevonden of verlopen. Probeer opnieuw.')], ephemeral: true });
      }

      await interaction.deferReply({ ephemeral: true });

      const topic = interaction.fields.getTextInputValue('topic_input') || null;
      const guild = interaction.guild;
      const categoryIndex = parseInt(chosen, 10);

      try {
        const { channel, ticketId } = await createTicketChannelFromChoice(guild, interaction.user, categoryIndex, topic);

        const channelUrl = `https://discord.com/channels/${guild.id}/${channel.id}`;
        const replyEmbed = new EmbedBuilder()
          .setTitle('Je ticket is geopend')
          .setDescription(`Klik hier om naar je ticket te gaan: <#${channel.id}>\n\nLink (browser): ${channelUrl}`)
          .setFooter({ text: `Ticket ID: ${ticketId}` })
          .setTimestamp()
          .setColor(0x57F287);

        await interaction.editReply({ embeds: [replyEmbed] });
      } catch (err) {
        console.error('Error creating ticket:', err);
        await interaction.editReply({ embeds: [embedError('Fout bij aanmaken', 'Er is iets misgegaan bij het aanmaken van je ticket. Probeer later opnieuw.')] });
      }
      return;
    }

    // BUTTONS
    if (interaction.isButton()) {
      // customId pattern: action_ticketId
      const [action, idStr] = interaction.customId.split('_');
      if (!idStr) return interaction.reply({ embeds: [embedError('Ongeldige actie', 'Actie bevat geen ticket id')], ephemeral: true });
      const ticketId = Number(idStr);
      const ticketRow = getTicketById(ticketId);
      if (!ticketRow) return interaction.reply({ embeds: [embedError('Niet gevonden', 'Ticket niet gevonden in database')], ephemeral: true });

      const member = interaction.member;
      const guild = interaction.guild;
      const channelObj = guild.channels.cache.get(ticketRow.channel_id);

      // Claim
      if (action === 'claim') {
        if (!isStaff(member)) return interaction.reply({ embeds: [embedError('Geen permissie', 'Alleen staff kan tickets claimen')], ephemeral: true });
        if (ticketRow.claimed_by) return interaction.reply({ embeds: [embedError('Al geclaimd', `Reeds geclaimd door <@${ticketRow.claimed_by}>`)], ephemeral: true });
        updateTicketClaim(ticketId, member.id);
        const embed = embedSuccess('Ticket geclaimd', `<@${member.id}> heeft dit ticket geclaimd.`);
        if (channelObj) await channelObj.send({ embeds: [embed] }).catch(() => {});
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // Unclaim
      if (action === 'unclaim') {
        if (!isStaff(member)) return interaction.reply({ embeds: [embedError('Geen permissie', 'Alleen staff kan unclaimen')], ephemeral: true });
        if (!ticketRow.claimed_by) return interaction.reply({ embeds: [embedError('Niet geclaimd', 'Ticket is niet geclaimd')], ephemeral: true });
        unclaimTicket(ticketId);
        const embed = embedAction('Ticket geunclaimd', `Ticket is vrijgegeven door <@${member.id}>.`);
        if (channelObj) await channelObj.send({ embeds: [embed] }).catch(() => {});
        return interaction.reply({ embeds: [embed], ephemeral: true });
      }

      // Close
      if (action === 'close') {
        if (!isStaff(member)) return interaction.reply({ embeds: [embedError('Geen permissie', 'Alleen staff kan tickets sluiten')], ephemeral: true });
        // mark closed in db immediately
        closeTicketRow(ticketId);

        const closingEmbed = embedAction('Ticket sluiten', 'Ticket wordt gesloten in 5 seconden. Transcript wordt aangemaakt en verstuurd.');
        if (channelObj) await channelObj.send({ embeds: [closingEmbed] }).catch(() => {});

        // reply ephemeral to invoker
        await interaction.reply({ embeds: [embedSuccess('Sluiten gestart', 'Ticket wordt binnen 5 seconden gesloten en transcript wordt gegenereerd.')], ephemeral: true });

        // wait 5 seconds then generate transcript and delete channel
        setTimeout(async () => {
          try {
            // double-check channel still exists
            const ch = guild.channels.cache.get(ticketRow.channel_id);
            if (!ch) return;

            const filepath = await makeTranscript(ch, ticketRow);

            // send to staff log if set
            if (STAFF_LOG_CHANNEL_ID) {
              const logCh = guild.channels.cache.get(STAFF_LOG_CHANNEL_ID) || await guild.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(() => null);
              if (logCh) {
                const att = new AttachmentBuilder(filepath);
                const logEmbed = embedInfo('Transcript Ticket', `Transcript voor ${ch.name} (ID:${ticketRow.id})`);
                await logCh.send({ embeds: [logEmbed], files: [att] }).catch(() => {});
              }
            }

            // DM owner
            try {
              const owner = await guild.members.fetch(ticketRow.owner_id).catch(() => null);
              if (owner) {
                const att = new AttachmentBuilder(filepath);
                const dmEmbed = embedInfo('Transcript van je ticket', `Hier is de transcript van je ticket ${ch.name}`);
                await owner.send({ embeds: [dmEmbed], files: [att] }).catch(() => {});
              }
            } catch (e) { /* ignore DM errors */ }

            // finally delete channel
            await ch.delete('Ticket closed by staff (with transcript)').catch(() => {});
          } catch (err) {
            console.error('Error during close timeout flow:', err);
            // If deletion failed, try to inform staff log
            if (STAFF_LOG_CHANNEL_ID) {
              const logCh = guild.channels.cache.get(STAFF_LOG_CHANNEL_ID) || await guild.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(() => null);
              if (logCh) {
                await logCh.send({ embeds: [embedError('Fout bij sluiten', `Fout tijdens sluiten van ticket ID ${ticketId}. Controleer logs.`)] }).catch(() => {});
              }
            }
          }
        }, 5000); // 5 seconds
        return;
      }

      // Transcript (manual)
      if (action === 'transcript') {
        if (!isStaff(member)) return interaction.reply({ embeds: [embedError('Geen permissie', 'Alleen staff kan transcript maken')], ephemeral: true });
        const ch = guild.channels.cache.get(ticketRow.channel_id);
        if (!ch) return interaction.reply({ embeds: [embedError('Kanaal niet gevonden', 'Ticket kanaal niet gevonden')], ephemeral: true });

        await interaction.reply({ embeds: [embedInfo('Transcript', 'Transcript wordt gemaakt en verzonden...')], ephemeral: true });
        try {
          const filepath = await makeTranscript(ch, ticketRow);
          if (STAFF_LOG_CHANNEL_ID) {
            const logCh = guild.channels.cache.get(STAFF_LOG_CHANNEL_ID) || await guild.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(() => null);
            if (logCh) {
              const att = new AttachmentBuilder(filepath);
              const logEmbed = embedInfo('Transcript', `Transcript voor ${ch.name}`);
              await logCh.send({ embeds: [logEmbed], files: [att] }).catch(() => {});
            }
          } else {
            const att = new AttachmentBuilder(filepath);
            await interaction.user.send({ embeds: [embedInfo('Transcript', `Transcript voor ${ch.name}`)], files: [att] }).catch(async () => {
              await interaction.followUp({ embeds: [embedError('DM mislukt', 'Kon DM niet sturen. Transcript is opgeslagen op de server.')], ephemeral: true }).catch(() => {});
            });
          }
        } catch (err) {
          console.error(err);
          await interaction.followUp({ embeds: [embedError('Fout', 'Fout bij het maken van transcript')], ephemeral: true });
        }
        return;
      }
    }

    // Slash commands
    if (interaction.isChatInputCommand()) {
      const name = interaction.commandName;
      const member = interaction.member;

      if (name === 'setup-ticket-panel') {
        if (!isStaff(member) && !member.permissions.has(PermissionFlagsBits.ManageGuild)) {
          return interaction.reply({ embeds: [embedError('Geen permissie', 'Alleen staff of managers kunnen het panel instellen.')], ephemeral: true });
        }

        const embed = new EmbedBuilder()
          .setTitle('🎫 Support Tickets')
          .setDescription('Kies een categorie via het dropdown menu om een ticket te openen. Ons support team helpt je verder!')
          .setFooter({ text: 'Support systeem' })
          .setTimestamp()
          .setColor(0x5865F2);

        const rows = [buildCategoryDropdown()];
        const files = [];
        if (PANEL_IMAGE_EXISTS) {
          files.push(new AttachmentBuilder(PANEL_IMAGE_PATH));
          embed.setImage('attachment://' + path.basename(PANEL_IMAGE_PATH));
        }

        await interaction.channel.send({ embeds: [embed], components: rows, files }).catch(err => {
          console.error('Error sending ticket panel:', err);
        });

        return interaction.reply({ embeds: [embedSuccess('Panel geplaatst', 'Ticket panel succesvol geplaatst.')], ephemeral: true });
      }

      // claim/unclaim/close/transcript via command
      if (['claim', 'unclaim', 'close', 'transcript'].includes(name)) {
        const channel = interaction.options.getChannel('channel') || interaction.channel;
        const ticketRow = getTicketByChannel(channel.id);
        if (!ticketRow) return interaction.reply({ embeds: [embedError('Geen ticket', 'Dit kanaal is geen geregistreerd ticket.')], ephemeral: true });
        if (!isStaff(member)) return interaction.reply({ embeds: [embedError('Geen permissie', 'Alleen staff kan deze actie uitvoeren.')], ephemeral: true });

        if (name === 'claim') {
          if (ticketRow.claimed_by) return interaction.reply({ embeds: [embedError('Al geclaimd', `Reeds geclaimd door <@${ticketRow.claimed_by}>`)], ephemeral: true });
          updateTicketClaim(ticketRow.id, member.id);
          await channel.send({ embeds: [embedSuccess('Ticket geclaimd', `<@${member.id}> heeft dit ticket geclaimd.`)] });
          return interaction.reply({ embeds: [embedSuccess('Geclaimd', `<@${member.id}> heeft het ticket geclaimd.`)], ephemeral: true });
        }

        if (name === 'unclaim') {
          if (!ticketRow.claimed_by) return interaction.reply({ embeds: [embedError('Niet geclaimd', 'Ticket is niet geclaimd.')], ephemeral: true });
          unclaimTicket(ticketRow.id);
          await channel.send({ embeds: [embedAction('Ticket geunclaimd', `Ticket is vrijgegeven door <@${member.id}>.`)] });
          return interaction.reply({ embeds: [embedSuccess('Geunclaimd', 'Ticket is geunclaimd.')], ephemeral: true });
        }

        if (name === 'close') {
          closeTicketRow(ticketRow.id);
          await interaction.reply({ embeds: [embedAction('Sluiten gestart', 'Ticket wordt gesloten en transcript wordt gemaakt (5s).')], ephemeral: true });
          // send closing embed in channel
          await channel.send({ embeds: [embedAction('Ticket sluiten', 'Ticket wordt gesloten in 5 seconden...')] }).catch(() => {});

          setTimeout(async () => {
            try {
              const ch = channel.guild.channels.cache.get(ticketRow.channel_id);
              if (!ch) return;
              const filepath = await makeTranscript(ch, ticketRow);
              if (STAFF_LOG_CHANNEL_ID) {
                const logCh = ch.guild.channels.cache.get(STAFF_LOG_CHANNEL_ID) || await ch.guild.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(() => null);
                if (logCh) {
                  await logCh.send({ embeds: [embedInfo('Transcript', `Transcript voor ${ch.name}`)], files: [new AttachmentBuilder(filepath)] }).catch(() => {});
                }
              }
              const ownerMember = await ch.guild.members.fetch(ticketRow.owner_id).catch(() => null);
              if (ownerMember) {
                await ownerMember.send({ embeds: [embedInfo('Transcript', `Transcript voor ${ch.name}`)], files: [new AttachmentBuilder(filepath)] }).catch(() => {});
              }
              await ch.delete('Ticket closed via command');
            } catch (err) {
              console.error(err);
            }
          }, 5000);

          return;
        }

        if (name === 'transcript') {
          await interaction.reply({ embeds: [embedInfo('Transcript', 'Transcript wordt gemaakt...')], ephemeral: true });
          try {
            const filepath = await makeTranscript(channel, ticketRow);
            if (STAFF_LOG_CHANNEL_ID) {
              const logCh = channel.guild.channels.cache.get(STAFF_LOG_CHANNEL_ID) || await channel.guild.channels.fetch(STAFF_LOG_CHANNEL_ID).catch(() => null);
              if (logCh) await logCh.send({ embeds: [embedInfo('Transcript', `Transcript voor ${channel.name}`)], files: [new AttachmentBuilder(filepath)] }).catch(() => {});
            } else {
              await interaction.user.send({ embeds: [embedInfo('Transcript', `Transcript voor ${channel.name}`)], files: [new AttachmentBuilder(filepath)] }).catch(async () => {
                await interaction.followUp({ embeds: [embedError('DM mislukt', 'Kon DM niet sturen; transcript opgeslagen op server')], ephemeral: true }).catch(() => {});
              });
            }
          } catch (err) {
            console.error(err);
            await interaction.followUp({ embeds: [embedError('Fout', 'Fout bij het maken van transcript')], ephemeral: true });
          }
          return;
        }
      }

      if (name === 'rename') {
        if (!isStaff(member)) return interaction.reply({ embeds: [embedError('Geen permissie', 'Alleen staff kan hernoemen.')], ephemeral: true });
        const newName = interaction.options.getString('name', true);
        try {
          await interaction.channel.setName(newName);
          return interaction.reply({ embeds: [embedSuccess('Kanaal hernoemd', `Kanaal hernoemd naar ${newName}`)], ephemeral: true });
        } catch (err) {
          console.error(err);
          return interaction.reply({ embeds: [embedError('Fout', 'Kon kanaal niet hernoemen.')], ephemeral: true });
        }
      }

      if (name === 'add' || name === 'remove') {
        if (!isStaff(member)) return interaction.reply({ embeds: [embedError('Geen permissie', 'Alleen staff kan leden toevoegen/verwijderen.')], ephemeral: true });
        const targetUser = interaction.options.getUser('user', true);
        const ch = interaction.channel;
        const ticketRow = getTicketByChannel(ch.id);
        if (!ticketRow) return interaction.reply({ embeds: [embedError('Geen ticket', 'Dit kanaal is geen ticket.')], ephemeral: true });

        if (name === 'add') {
          await ch.permissionOverwrites.create(targetUser.id, { ViewChannel: true, SendMessages: true, ReadMessageHistory: true });
          await ch.send({ embeds: [embedInfo('Gebruiker toegevoegd', `<@${targetUser.id}> is toegevoegd door <@${member.id}>`)] });
          return interaction.reply({ embeds: [embedSuccess('Toegevoegd', `<@${targetUser.id}> toegevoegd aan ticket.`)], ephemeral: true });
        } else {
          await ch.permissionOverwrites.delete(targetUser.id).catch(() => {});
          await ch.send({ embeds: [embedInfo('Gebruiker verwijderd', `<@${targetUser.id}> is verwijderd door <@${member.id}>`)] });
          return interaction.reply({ embeds: [embedSuccess('Verwijderd', `<@${targetUser.id}> verwijderd uit ticket.`)], ephemeral: true });
        }
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    try {
      if (interaction && !interaction.replied) await interaction.reply({ embeds: [embedError('Error', 'Er is iets misgegaan.')], ephemeral: true });
    } catch {}
  }
});

client.once('ready', async () => {
  console.log(`Bot ingelogd als ${client.user.tag}`);
  await registerCommands();
});

client.login(TOKEN);
