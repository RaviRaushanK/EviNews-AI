'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('claims', {
      id: {
        type: Sequelize.UUID,
        defaultValue: Sequelize.UUIDV4,
        primaryKey: true,
        comment: 'Unique identifier for the claim'
      },
      article_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'articles', key: 'id' },
        onDelete: 'RESTRICT',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to articles.id'
      },
      event_id: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'events', key: 'id' },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
        comment: 'Foreign key to events.id (nullable)'
      },
      claim_text: {
        type: Sequelize.TEXT,
        allowNull: false,
        comment: 'The extracted claim statement'
      },
      claim_type: {
        type: Sequelize.ENUM('fact', 'opinion', 'quote', 'data'),
        allowNull: false,
        defaultValue: 'fact',
        comment: 'Classification of the claim'
      },
      confidence_score: {
        type: Sequelize.FLOAT,
        allowNull: true,
        comment: 'Confidence score (0.0 to 1.0)'
      },
      extracted_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'When the claim was extracted'
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

    await queryInterface.addIndex('claims', ['article_id'], {
      name: 'idx_claims_article_id'
    });
    await queryInterface.addIndex('claims', ['event_id'], {
      name: 'idx_claims_event_id'
    });
    await queryInterface.addIndex('claims', ['claim_type'], {
      name: 'idx_claims_claim_type'
    });
    await queryInterface.addIndex('claims', ['article_id', 'event_id'], {
      name: 'idx_claims_article_event'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('claims');
  }
};