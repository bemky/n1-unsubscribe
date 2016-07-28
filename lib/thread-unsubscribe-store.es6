const {
  Actions,
  TaskFactory,
  FocusedPerspectiveStore,
  NylasAPI,
} = require('nylas-exports');

const NylasStore = require('nylas-store');
const _ = require('underscore');
const cheerio = require('cheerio');
const BrowserWindow = require('electron').remote.BrowserWindow;
const MailParser = require('mailparser').MailParser;
const ThreadConditionType = require(`${__dirname}/enum/threadConditionType`);
const open = require('open');
const blacklist = require(`${__dirname}/blacklist.json`);

class ThreadUnsubscribeStore extends NylasStore {
  constructor(thread) {
    super();

    // Enums
    this.LinkType = {
      EMAIL: 'EMAIL',
      BROWSER: 'BROWSER',
    };

    this.thread = thread;
    this.threadState = {
      id: this.thread.id,
      condition: ThreadConditionType.LOADING,
      hasLinks: false,
    }
    this.messages = this.thread.metadata;
    this.links = [];
    this.loadLinks();
  }

  // Checks if an unsubscribe link can be found in the email
  // Returns a boolean whether it is possible to unsubscribe
  canUnsubscribe() {
    return this.links.length > 0;
  }

  triggerUpdate() {
    this.trigger(this.threadState);
  }

  // Opens the unsubscribe link to unsubscribe the user
  // The optional callback returns: (Error, Boolean indicating whether it was a success)
  unsubscribe() {
    if (this.canUnsubscribe()) {
      const unsubscribeHandler = (error) => {
        if (!error) {
          this.moveThread();
          this.threadState.condition = ThreadConditionType.UNSUBSCRIBED;
        } else {
          this.threadState.condition = ThreadConditionType.ERRORED;
        }

        this.triggerUpdate();
      };

      // Determine if best to unsubscribe via email or browser:
      if (this.links[0].type === this.LinkType.EMAIL) {
        this.unsubscribeViaMail(this.links[0].link, unsubscribeHandler);
      } else {
        this.unsubscribeViaBrowser(this.links[0].link, unsubscribeHandler);
      }
    }
  }

  // Initializes the _links array by analyzing the headers and body of the current email thread
  loadLinks() {
    this.loadMessagesViaAPI((error, email) => {
      if (!error) {
        // Take note when asking to unsubscribe later:
        this.isForwarded = this.thread.subject.match(/^Fwd: /i);
        if (this.isForwarded) {
          this.confirmText = `The email was forwarded, are you sure that you` +
            ` want to unsubscribe?`;
        } else {
          this.confirmText = `Are you sure that you want to unsubscribe?`;
        }

        // Find and concatenate links:
        const headerLinks = this.parseHeadersForLinks(email.headers);
        const bodyLinks = this.parseBodyForLinks(email.html);
        this.links = this.parseLinksForTypes(headerLinks.concat(bodyLinks));
        this.threadState.hasLinks = (this.links.length > 0);
        if (this.threadState.hasLinks) {
          this.threadState.condition = ThreadConditionType.DONE;
        } else {
          this.threadState.condition = ThreadConditionType.DISABLED;
        }
        // This quickly adds up, so only log this info when debugging:
        if (NylasEnv.inDevMode() === true) {
          if (this.threadState.hasLinks) {
            console.info(`Found links for: "${this.thread.subject}"`);
            console.info({headerLinks, bodyLinks});
            // console.table([["Header links:", headerLinks[0]], ["Body links:", bodyLinks[0]]]);
          } else {
            console.log(`Found no links for: "${this.thread.subject}"`);
          }
        }
      } else if (error === 'sentMail') {
        console.log(`Can\'t parse "${this.thread.subject}"" because it was sent from this account`);
        this.threadState.condition = ThreadConditionType.DISABLED;
      } else {
        if (NylasEnv.inDevMode() === true) {
          console.warn(`\n--Error in querying message: ${this.thread.subject}--\n`);
          console.warn(error);
          console.warn(email);
        }
        this.threadState.condition = ThreadConditionType.ERRORED;
      }
      this.triggerUpdate();
    });
  }

  // Makes an API request to fetch the data on the
  // NOTE: This will only make a request for the first email message in the thread,
  // instead of all messages based on the assumption that all of the emails in the
  // thread will have the unsubscribe link.
  // Callback: (Error, Parsed email)
  loadMessagesViaAPI(callback) {
    // Ignore any sent messages because they return a 404 error:
    let type = '';
    let sentMail = false;
    if (this.messages[0] && this.messages[0].categories) {
      _.each(this.messages[0].categories, (category) => {
        type = category.displayName;
        if (type === "Sent Mail") {
          sentMail = true;
        }
      });
    }
    if (sentMail) {
      // callback(new Error('Sent email.'));
      // No error, sort of...
      callback('sentMail', null);
    } else {
      if (this.messages && this.messages.length > 0) {
        // if (NylasEnv.inDevMode() === true) {
        //   console.log('-----break------')
        //   console.log(`Checking "${this.thread.subject}" with length ` +
        //     ` of: ${this.messages.length}`);
        //   console.log(this.messages[0]);
        // }
        const messagePath = `/messages/${this.messages[0].id}`;
        if (!this.messages[0].draft) {
          NylasAPI.makeRequest({
            path: messagePath,
            accountId: this.thread.accountId,
            // Need raw email to get email headers (see: https://nylas.com/docs/#raw_message_contents)
            headers: {Accept: "message/rfc822"},
            json: false,
            success: (rawEmail) => {
              const mailparser = new MailParser();
              mailparser.on('end', (parsedEmail) => {
                callback(null, parsedEmail);
              });
              mailparser.write(rawEmail);
              mailparser.end();
            },
            error: (error) => {
              callback(error);
            },
          });
        } else {
          callback(new Error('Draft emails aren\'t parsed for unsubscribe links.'));
        }
      } else {
        callback(new Error('No messages found to parse for unsubscribe links.'));
      }
    }
  }

  // Examine the email headers for the list-unsubscribe header
  parseHeadersForLinks(headers) {
    const unsubscribeLinks = [];
    if (headers && headers['list-unsubscribe']) {
      const rawLinks = headers['list-unsubscribe'].split(/,/g);
      rawLinks.forEach((link) => {
        const trimmedLink = link.trim();
        if (/mailto.*/g.test(link)) {
          if (this.checkEmailBlacklist(trimmedLink) === false) {
            unsubscribeLinks.push(trimmedLink.substring(1, trimmedLink.length - 1));
          }
        } else {
          // if (this.checkLinkBlacklist(trimmedLink) === false) {
          unsubscribeLinks.push(trimmedLink.substring(1, trimmedLink.length - 1));
        }
      });
    }
    return unsubscribeLinks;
  }

  // Parse the HTML within the email body for unsubscribe links
  parseBodyForLinks(emailHTML) {
    const unsubscribeLinks = [];
    if (emailHTML) {
      const $ = cheerio.load(emailHTML);
      // Get a list of all anchor tags with valid links
      let links = _.filter($('a'), (emailLink) => emailLink.href !== 'blank');
      links = links.concat(this.getLinkedSentences($));
      const regexps = [
        /unsubscribe/gi,
        /opt[ -]{0,2}out/gi,
        /email preferences/gi,
        /subscription/gi,
        /notification settings/gi,
        // Danish
        /afmeld/gi,
        /afmelden/gi,
        /af te melden voor/gi,
        // Spanish
        /darse de baja/gi,
        // French
        /désabonnement/gi,
        /désinscrire/gi,
        /désinscription/gi,
        /désabonner/gi,
        /préférences d'email/gi,
        /préférences d'abonnement/gi,
        // Russian - this is probably wrong:
        /отказаться от подписки/gi,
        // Serbian
        /одјавити/gi,
        // Icelandic
        /afskrá/gi,
        // Hebrew
        /לבטל את המנוי/gi,
        // Creole (Haitian)
        /koupe abònman/gi,
        // Chinese (Simplified)
        /退订/gi,
        // Chinese (Traditional)
        /退訂/gi,
        // Arabic
        /إلغاء الاشتراك/gi,
        // Armenian
        /պետք է նախ միանալ/gi,
        // German
        /abmelden/gi,
        /ausschreiben/gi,
        /austragen/gi,
      ];

      for (let j = 0; j < links.length; j++) {
        const link = links[j];
        for (let i = 0; i < regexps.length; i++) {
          const re = regexps[i];
          if (re.test(link.href) || re.test(link.innerText)) {
            unsubscribeLinks.push(link.href);
          }
        }
      }
    }
    return unsubscribeLinks;
  }

  // Given a list of unsubscribe links (Strings)
  // Returns a list of objects with a link and a LinkType
  // The returned list is in the same order as links,
  // except that EMAIL links are pushed to the front.
  parseLinksForTypes(links) {
    const newLinks = _.sortBy(_.map(links, (link) => {
      const type = (/mailto.*/g.test(link) ? this.LinkType.EMAIL : this.LinkType.BROWSER);
      const data = {link, type};
      if (type === this.LinkType.EMAIL) {
        const matches = /mailto:([^\?]*)/g.exec(link);
        if (matches && matches.length > 1) {
          data.link = matches[1];
        }
      }
      return data;
    }), (link) => {
      // Move email links to the front
      if (link.type === this.LinkType.EMAIL) {
        this.threadState.isEmail = true;
        return 0;
      }
      return 1;
    });
    return newLinks;
  }
  // Takes a String URL to later open a URL
  unsubscribeViaBrowser(url, callback) {
    // NylasEnv.confirm({
    //   message: 'How you feeling?',
    //   detailedMessage: 'Be honest.',
    //   buttons: {
    //     Good: () => {
    //       console.log('good')
    //       return window.alert('good to hear');
    //     },
    //     Bad: () => {
    //       console.log('bad')
    //       return window.alert('bummer');
    //     },
    //   },
    // });
    const disURL = this.shortenURL(url);
    if ((!this.isForwarded && process.env.N1_UNSUBSCRIBE_CONFIRM_BROWSER === 'false') ||
      confirm(`${this.confirmText}\nA browser will be opened at:\n\n${disURL}`)) {
      if (NylasEnv.inDevMode() === true) {
        console.log(`Opening a browser window to:\n${url}`);
      }

      if (this.checkLinkBlacklist(url) ||
        process.env.N1_UNSUBSCRIBE_USE_BROWSER === 'true') {
        // Open the user's default browser to the specific URL
        open(url);
        callback(null);
      } else {
        const browserWindow = new BrowserWindow({
          'web-preferences': { 'web-security': false },
          width: 1000,
          height: 800,
          center: true,
          // 'preload': path.join(__dirname, 'inject.js'),
        });

        browserWindow.on('closed', () => {
          callback(null, true);
        });

        // browserWindow.on('page-title-updated', function(event) {
        //  webContents = browserWindow.webContents;
        //  if (!webContents.isDevToolsOpened()) {
        //    webContents.openDevTools();
        //  }
        // });

        browserWindow.loadURL(url);
        browserWindow.show();
      }
    }
  }

  // Quick solution to
  shortenURL(url) {
    // modified from: http://stackoverflow.com/a/26766402/3219667
    const regex = /^([^:\/?#]+:?\/\/([^\/?#]*))/i;
    const disURL = regex.exec(url)[0];
    return `${disURL}/...`;
  }

  // Determine if the link can be opened in the electron browser or if it
  // should be directed to the default browser
  checkLinkBlacklist(url) {
    const regexps = blacklist.browser;
    return this.regexpcompare(regexps, url);
  }

  // Determine if the unsubscribe email is valid
  checkEmailBlacklist(email) {
    const regexps = blacklist.emails;
    return this.regexpcompare(regexps, email);
  }

  // Takes an array of regular expressions and compares against a target string
  // Returns true if a match is found
  regexpcompare(regexps, target) {
    for (let i = 0; i < regexps.length; i++) {
      const re = new RegExp(regexps[i]);
      // if (NylasEnv.inDevMode() === true) {
      //   console.log(`Checking blacklist with: ${re}`);
      // }
      if (re.test(target)) {
        if (NylasEnv.inDevMode() === true) {
          console.log(`Found ${target} on blacklist with ${re}`);
        }
        return true;
      }
    }
    return false;
  }

  // Takes a String email address and sends an email to it in order to unsubscribe from the list
  unsubscribeViaMail(emailAddress, callback) {
    if (emailAddress) {
      if ((!this.isForwarded && process.env.N1_UNSUBSCRIBE_CONFIRM_EMAIL === 'false') ||
        confirm(`${this.confirmText}\nAn email will be sent to:\n${emailAddress}`)) {
        if (NylasEnv.inDevMode() === true) {
          console.log(`Sending an unsubscription email to:\n${emailAddress}`);
        }

        NylasAPI.makeRequest({
          path: '/send',
          method: 'POST',
          accountId: this.thread.accountId,
          body: {
            body: 'This is an automated unsubscription request. ' +
              'Please remove the sender of this email from all email lists.',
            subject: 'Unsubscribe',
            to: [{
              email: emailAddress,
            }],
          },
          success: () => {
            // Do nothing - for now
          },
          error: (error) => {
            console.error(error);
          },
        });

        // Temporary solution right now so that emails are trashed immediately
        // instead of waiting for the email to be sent.
        callback(null);
      } else {
        callback(new Error('Did not confirm -- do not unsubscribe.'));
      }
    } else {
      callback(new Error(`Invalid email address (${emailAddress})`));
    }
  }

  // Move the given thread to the trash
  // From Thread-List Package
  // https://github.com/nylas/N1/blob/master/internal_packages/thread-list/lib/thread-list.cjsx
  moveThread() {
    if (this.thread) {
      if (process.env.N1_UNSUBSCRIBE_THREAD_HANDLING === 'trash') {
        // Trash the thread
        if (FocusedPerspectiveStore.current().canTrashThreads([this.thread])) {
          const tasks = TaskFactory.tasksForMovingToTrash({
            threads: [this.thread],
            fromPerspective: FocusedPerspectiveStore.current(),
          });
          Actions.queueTasks(tasks);
        }
      } else if (process.env.N1_UNSUBSCRIBE_THREAD_HANDLING === 'archive') {
        // Archive the thread
        if (FocusedPerspectiveStore.current().canArchiveThreads([this.thread])) {
          const tasks = TaskFactory.tasksForArchiving({
            threads: [this.thread],
            fromPerspective: FocusedPerspectiveStore.current(),
          });
          Actions.queueTasks(tasks);
        }
      }
      Actions.popSheet();
    }
  }

  // Takes a parsed DOM (through cheerio) and returns sentences that contain links
  // Good at catching cases such as
  //    "If you would like to unsubscrbe from our emails, please click here."
  // Returns a list of objects, each representing a single link
  // Each object contains an href and innerText property
  getLinkedSentences($) {
    // Get a unique list of parents to <a> tags
    const aParents = [];
    $('a').each((index, aTag) => {
      if (aTag) {
        if (!$(aParents).is(aTag.parent)) {
          aParents.unshift(aTag.parent);
        }
      }
    });

    const linkedSentences = [];
    $(aParents).each((parentIndex, parent) => {
      // console.log($(parent));
      let link = undefined;
      let leftoverText = "";
      if (parent) {
        $(parent.children).each((childIndex, child) => {
          // console.log(child);
          if ($(child).is($('a'))) {
            if (link !== undefined && leftoverText.length > 0) {
              linkedSentences.push({
                href: link,
                innerText: leftoverText,
              });
              leftoverText = "";
            }
            link = $(child).attr('href');
            // console.log("Found link: " + link);
          }
          const text = $(child).text();
          const re = /(.*\.|!|\?\s)|(.*\.|!|\?)$/g;
          // console.log("text: " + text);
          if (re.test(text)) {
            const splitup = text.split(re);
            // console.log(splitup);
            for (let i = 0; i < splitup.length; i++) {
              if (splitup[i] !== "" && splitup[i] !== undefined) {
                if (link !== undefined) {
                  const fullLine = leftoverText + splitup[i];
                  // console.log("FULL LINE: " + fullLine);
                  linkedSentences.push({
                    href: link,
                    innerText: fullLine,
                  });
                  link = undefined;
                  leftoverText = "";
                } else {
                  leftoverText += splitup[i];
                }
              }
            }
          } else {
            leftoverText += text;
            // console.log("leftoverText: " + leftoverText);
          }
          leftoverText += " ";
        });
      }
      // Case occures when an end of sentence is not found
      if (link !== undefined && leftoverText.length > 0) {
        linkedSentences.push({
          href: link,
          innerText: leftoverText,
        });
      }
    });
    // console.log(linkedSentences);
    return linkedSentences;
  }
}

module.exports = ThreadUnsubscribeStore;
