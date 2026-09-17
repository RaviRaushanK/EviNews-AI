'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('event_articles', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the event-article link'
      },
      event_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'events', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to events.id'
      },
      article_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'articles', key: 'id' },
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to articles.id'
      },
      cluster_score: {
        type: Sequelize.FLOAT,
        allowNull: true,
        comment: 'Confidence score from the clustering algorithm'
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

    await queryInterface.addIndex('event_articles', ['event_id'], {
      name: 'idx_event_articles_event_id'
    });
    await queryInterface.addIndex('event_articles', ['article_id'], {
      name: 'idx_event_articles_article_id'
    });
    await queryInterface.addIndex('event_articles', ['event_id', 'article_id'], {
      name: 'idx_event_articles_unique',
      unique: true
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('event_articles');
  }
};