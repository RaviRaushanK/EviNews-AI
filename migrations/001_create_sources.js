'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sources', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the news source'
      },
      name: {
        type: Sequelize.STRING(255),
        allowNull: false,
        unique: true,
        comment: 'Display name of the news source'
      },
      url: {
        type: Sequelize.STRING(512),
        allowNull: true,
        unique: true,
        comment: 'Primary website URL of the source'
      },
      rss_url: {
        type: Sequelize.STRING(512),
        allowNull: true,
        unique: true,
        comment: 'RSS feed URL for the source'
      },
      api_identifier: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Identifier used by the News API (e.g., bbc-news)'
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.NOW
      }
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sources');
  }
};